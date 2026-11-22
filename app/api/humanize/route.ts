import { NextRequest, NextResponse } from 'next/server';
import { ModelProvider, StylePreset, Intensity } from '@/lib/types';
import { getSystemPrompt, getSelfCheckPrompt, getCorpusAwareSystemPrompt, LEVEL_PARAMS } from '@/lib/prompts';
import { getAzerbaijaniPolishPrompt } from '@/lib/prompts-az';
import { findAzerbaijaniRewriteIssues } from '@/lib/az-quality';
import { getProvider, isCliOnlyProvider, resolveModelId } from '@/lib/providers';
import { generateWithProvider } from '@/lib/server/providers-runtime';
import { detectAI } from '@/lib/detector';
import { postprocess, corpusAwarePostprocess, safeClean, intensityPostprocess, scrubAIText } from '@/lib/postprocess';
import { localRehumanizeSentence, replaceSentencesInText } from '@/lib/rehumanize';
import { loadStyleModelAsync, loadStyleModel, hasStyleModel } from '@/lib/style-model';
import { calibrateWithCorpus } from '@/lib/detector';
import { chainModels } from '@/lib/chain';
import { humanizeWithRudra, isRudraHumanizerConfigured } from '@/lib/server/rudra-free';
import {
  appendAuditLog,
  applyRewriteRegressionGuard,
  buildConfidenceReport,
  enforceSafetyPolicy,
} from '@/lib/server/humanization-governance';
import { scoreHumanLikeness } from '@/lib/server/model-runtime';
import { asyncMapConcurrent } from '@/lib/batch';
import { checkRateLimit } from '@/lib/rate-limit';
import { countWords, chunkText } from '@/lib/storage';
import { buildSentenceResults, isAzerbaijaniText } from '@/lib/text-utils';
import { extractRegions, restoreRegions, containsPlaceholders } from '@/lib/protect-regions';
import { assessSemanticFidelity } from '@/lib/semantic-fidelity';
import { estimateRunCost } from '@/lib/observability';

const MAX_BATCH_SIZE = 20;

// Reserved for future self-check integration
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function llmSelfCheck(
  provider: ModelProvider,
  apiKey: string,
  text: string
): Promise<{ score: number; issues: string[]; flaggedSentences: string[] }> {
  try {
    const prompt = getSelfCheckPrompt().replace('{TEXT}', text.slice(0, 3000));
    const providerInfo = getProvider(provider);
    const result = await generateWithProvider(provider, apiKey, prompt, '', {
      model: providerInfo?.defaultModel,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 1024,
    });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        score: Math.min(100, Math.max(0, Number(parsed.score) || 50)),
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        flaggedSentences: Array.isArray(parsed.flaggedSentences) ? parsed.flaggedSentences : [],
      };
    }
  } catch {}
  return { score: 50, issues: [], flaggedSentences: [] };
}

// Vercel function timeout — gemma3:4b on Oracle's free ARM CPU takes ~15s per
// 100 words. A 600-word essay runs ~90s upstream; we set maxDuration=120 so
// long inputs don't get killed mid-call. The fetch inside rudra-free.ts
// caps at 110s so we get a clean error response back instead of Vercel's 504.
export const maxDuration = 120;

export async function POST(request: NextRequest) {
  try {
    const startedAt = Date.now();

    // Rate limiting
    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    const rateLimit = checkRateLimit(ip);
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please try again later.' },
        { status: 429 },
      );
    }

    // Body size guard
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > 2_000_000) {
      return NextResponse.json({ success: false, error: 'Request body too large.' }, { status: 413 });
    }

    const {
      text, style, model, apiKey,
      targetScore, language, writingSample,
            postprocess: enablePostprocess = true,
      chainModels: chainModelIds = [],
      apiKeys: extraApiKeys = {},
      batchTexts = [],
      freezeWords = '',
      synonymIntensity = 15,
      intensity: requestIntensity,
      modelVariants = {},
    } = await request.json();

    // Resolve intensity: explicit request wins; else 'stealth' style defaults to
    // aggressive, everything else to light (preserves prior behaviour).
    const intensity: Intensity = ['light', 'medium', 'aggressive', 'ninja'].includes(requestIntensity)
      ? (requestIntensity as Intensity)
      : (style === 'stealth' ? 'aggressive' : 'light');

    if (!text || !model) return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    // "Rudra's Free Usage Model" needs no client apiKey — the server uses a
    // preconfigured Vercel env var. Skip all the provider/cli/apiKey checks.
    const isRudraFree = model === 'rudra-free';
    const effectiveApiKey = apiKey || (model === 'gemini' ? process.env.GEMINI_API_KEY : undefined) || (model ? process.env[`${String(model).toUpperCase().replace(/-/g, '_')}_API_KEY`] : undefined) || '';
    if (!isRudraFree && !effectiveApiKey) return NextResponse.json({ success: false, error: 'API açarı tələb olunur. Settings bölməsindən və ya .env faylından daxil edin.' }, { status: 400 });
    // Reject CLI-only runners on the primary model AND anywhere in the chain —
    // chainModels flows through lib/chain into the CLI-capable runtime, so an
    // unguarded chain entry would otherwise spawn the server's local CLI.
    const cliOnlyRequested = [model, ...(Array.isArray(chainModelIds) ? chainModelIds : [])]
      .find((id) => isCliOnlyProvider(id as ModelProvider));
    if (cliOnlyRequested) return NextResponse.json({ success: false, error: `Provider "${cliOnlyRequested}" is a local CLI runner and is not available over the web API. Use the stealthhumanizer CLI.` }, { status: 400 });
    if (isRudraFree && !isRudraHumanizerConfigured()) {
      return NextResponse.json({ success: false, error: "Rudra's Free Usage Model is not configured on this deployment. Set RUDRA_HUMANIZER_API_KEY or pick a different provider." }, { status: 503 });
    }
    if (countWords(text) > 10000) return NextResponse.json({ success: false, error: 'Exceeds 10,000 word limit' }, { status: 400 });
    if (Array.isArray(batchTexts) && batchTexts.length > MAX_BATCH_SIZE) {
      return NextResponse.json({ success: false, error: `Batch size exceeds limit (${MAX_BATCH_SIZE}).` }, { status: 400 });
    }

    const safety = enforceSafetyPolicy(text);
    if (safety.blocked) {
      return NextResponse.json(
        {
          success: false,
          error: 'Request blocked by safety policy.',
          reasons: safety.reasons,
          safeUseGuidance: safety.safeUseGuidance,
        },
        { status: 400 }
      );
    }

    // Load corpus style model
    await loadStyleModelAsync();
    const useCorpus = hasStyleModel();

    // Calibrate detector with corpus
    if (useCorpus) {
      const styleModel = loadStyleModel();
      if (styleModel) calibrateWithCorpus(styleModel);
    }

    // Higher intensity -> higher temperature for higher perplexity (less
    // predictable = harder to detect).
    const params = intensity === 'ninja'
      ? { temperature: 0.95, topP: 0.95 }
      : (intensity === 'aggressive' || style === 'stealth')
        ? { temperature: 0.92, topP: 0.95 }
        : { temperature: 0.88, topP: 0.95 };
    const effectiveLanguage = (language === 'auto' || !language)
      ? (isAzerbaijaniText(text) ? 'az' : language)
      : language;

    const systemPrompt = useCorpus
      ? getCorpusAwareSystemPrompt(style, writingSample, undefined, effectiveLanguage, freezeWords, intensity)
      : getSystemPrompt(style, writingSample, effectiveLanguage, freezeWords, intensity);
    const providerInfo = getProvider(model);
    const modelId = resolveModelId(model, modelVariants?.[model]);

    if (Array.isArray(batchTexts) && batchTexts.length > 0) {
      const selected = batchTexts.slice(0, MAX_BATCH_SIZE).filter((item: unknown) => typeof item === 'string' && item.trim().length > 0);
      // Use concurrency-limited batch processing
      const batchResults = await asyncMapConcurrent(
        selected,
        async (batchInput: string, i: number) => {
          const itemLang = (language === 'auto' || !language)
            ? (isAzerbaijaniText(batchInput) ? 'az' : language)
            : language;
          const itemPrompt = useCorpus
            ? getCorpusAwareSystemPrompt(style, writingSample, undefined, itemLang, freezeWords, intensity)
            : getSystemPrompt(style, writingSample, itemLang, freezeWords, intensity);
          const { masked: maskedBatch, regions: batchRegions } = extractRegions(batchInput);
          const chunks = chunkText(maskedBatch, 2500);
          let rewritten = '';
          if (isRudraFree) {
            const r = await humanizeWithRudra(batchInput);
            rewritten = r.text;
          } else {
            for (let j = 0; j < chunks.length; j++) {
              const placeholderNote = containsPlaceholders(chunks[j])
                ? '\n\nVacib: __PROTECT_N__ işarələrini dəyişmədən eynilə saxla.'
                : '';
              const out = await generateWithProvider(model, effectiveApiKey, itemPrompt, chunks[j] + placeholderNote, {
                model: modelId,
                temperature: params.temperature,
                topP: params.topP,
              });
              rewritten += (j > 0 ? '\n\n' : '') + out;
            }
          }
          const postprocessed = enablePostprocess ? postprocess(rewritten, { light: true, style: style as any, synonymIntensity }) : rewritten;
          const final = restoreRegions(scrubAIText(postprocessed), batchRegions);
          const detection = detectAI(final);
          const confidenceReport = buildConfidenceReport(detection.score);
          const runtimeModelScore = await scoreHumanLikeness(final);
          const semanticFidelity = assessSemanticFidelity(batchInput, final);
          return { index: i, fullText: final, finalScore: detection.score, confidenceReport, runtimeModelScore, semanticFidelity };
        },
        3,
      );

      await appendAuditLog({
        timestamp: new Date().toISOString(),
        route: '/api/humanize',
        model,
        mode: 'batch',
        batchCount: batchResults.length,
      });

      return NextResponse.json({
        success: true, mode: 'batch',
        count: batchResults.length,
        results: batchResults,
        model,
        modelName: providerInfo?.name || model,
      });
    }

    const target = targetScore || 80;
    void target;
    // Match chunk size to the provider's output token budget.
    // Azerbaijani uses ~2.5-3.2 tokens per word (agglutinative + Unicode chars),
    // and Groq free tier caps max_tokens at 900 per request (~220 AZ words / ~450 EN words).
    const chunkSize = model === 'groq'
      ? (effectiveLanguage === 'az' ? 220 : 450)
      : (effectiveLanguage === 'az' ? 900 : 2500);
    // Protect URLs, emails, inline/fenced code, LaTeX math, and markdown links from LLM mangling.
    const { masked: maskedText, regions: protectedRegions } = isRudraFree
      ? { masked: text, regions: [] }
      : extractRegions(text);
    const chunks = chunkText(maskedText, chunkSize);

    // Language note helper (computes word target per chunk so multi-chunk inputs never ask for full-doc length)
    const buildLangNote = (chunkTextStr: string): string => {
      if (effectiveLanguage === 'az') {
        const chunkWords = countWords(chunkTextStr);
        return `\n\nVacib: Mətn Azərbaycan dilindədir. Eyni dildə (Azərbaycan dilində), seçilmiş üslubu və abzas quruluşunu qoruyaraq təxminən ${chunkWords} söz (±15%) həcmində təbii və axıcı şəkildə yenidən yaz. Mətni qısaltma və tərcümə etmə.`;
      }
      if (effectiveLanguage && effectiveLanguage !== 'en' && effectiveLanguage !== 'auto' && effectiveLanguage !== 'zh-CN' && effectiveLanguage !== 'zh-TW') {
        return '\n\nIMPORTANT: The text is in a language other than English. Rewrite it in the SAME language. Do NOT translate.';
      }
      return '';
    };
    const langNote = buildLangNote(maskedText);

    // ==================== LAYER 1: LLM Rewrite (or Rudra Free proxy) ====================
    let humanizedText = '';
    if (isRudraFree) {
      // Rudra's hosted model takes the whole text in one shot — no chunking,
      // no system prompt. The model is purpose-built for humanization.
      const rudraResult = await humanizeWithRudra(text);
      humanizedText = rudraResult.text;
    } else {
      for (let i = 0; i < chunks.length; i++) {
        const placeholderNote = containsPlaceholders(chunks[i])
          ? (effectiveLanguage === 'az'
            ? '\n\nMÜTLƏQ: Mətndəki __PROTECT_N__ işarələrini (kod, URL, düstur, istinad yerləri) heç bir dəyişiklik etmədən eynilə saxla.'
            : '\n\nCRITICAL: Reproduce every __PROTECT_N__ placeholder token EXACTLY as written with no modifications.')
          : '';
        const chunkPrompt = chunks[i] + buildLangNote(chunks[i]) + placeholderNote;
        const result = await generateWithProvider(model, effectiveApiKey, systemPrompt, chunkPrompt, {
          model: modelId,
          temperature: params.temperature,
          topP: params.topP,
        });
        humanizedText += (i > 0 ? '\n\n' : '') + result;
      }
    }

    let passes = 1;
    let currentText = humanizedText;

    // Rudra's Free Usage Model: gemma3:4b already produces natural, faithful
    // rewrites via the humanize system prompt on the Oracle side. The full
    // postprocessing pipeline (corpus swaps, synonym replacement, intensity
    // rewrites, ninja surgical edits) was designed for weaker LLM outputs and
    // actively degrades gemma's text — running it would mangle contractions,
    // re-introduce AI fingerprints, and shorten the output. Bypass every
    // post-LLM layer for Rudra and let the API output stand on its own.
    if (!isRudraFree) {
      // ==================== LAYER 2: Post-Processing ====================
      // Always apply corpus-aware post-processing if model is loaded
      if (useCorpus) {
        currentText = corpusAwarePostprocess(currentText);
      }
      // Also apply regular post-processing if toggled on (ALWAYS light mode to
      // prevent destructive transformations like reordering/randomization)
      if (enablePostprocess) {
        currentText = postprocess(currentText, { light: true, style: style as any, synonymIntensity });
      }

      // ==================== LAYER 3: Multi-Model Chain ====================
      if (chainModelIds && chainModelIds.length > 0) {
        // Build chain config from provided model IDs and API keys (using effectiveApiKey fallback)
        const allApiKeys = { ...extraApiKeys, [model]: effectiveApiKey };
        const chainConfig = chainModelIds
          .filter((id: string) => allApiKeys[id])
          .map((id: string) => ({
            provider: id as ModelProvider,
            apiKey: allApiKeys[id],
          }));

        if (chainConfig.length > 0) {
          const chainResult = await chainModels({
            text: currentText,
            chainModels: chainConfig,
            style: style as StylePreset,
            language: effectiveLanguage,
            langNote,
            modelVariants,
          });
          currentText = chainResult.text;
          passes += chainResult.passes.length;
        }
      }

      // ==================== LAYER 3b: Silent Azerbaijani Pass-2 Native Polish ====================
      // In ninja (or aggressive with 2+ remaining issues) on a single provider,
      // silently check for leftover verbatim 5-grams, AI clichés, Turkish calques,
      // repetitive openers, or heavy passive voice, and run a targeted low-temp
      // native editor pass to eliminate them without showing noisy warnings.
      if (
        effectiveLanguage === 'az' &&
        chainModelIds.length === 0 &&
        (intensity === 'ninja' || intensity === 'aggressive')
      ) {
        const audit = findAzerbaijaniRewriteIssues(maskedText, currentText);
        const shouldRunPolish =
          (intensity === 'ninja' && audit.needsPolish) ||
          (intensity === 'aggressive' && audit.issues.length >= 2);
        if (shouldRunPolish) {
          try {
            const polishPrompt = getAzerbaijaniPolishPrompt(audit.issues, style as StylePreset);
            const polishChunks = chunkText(currentText, chunkSize);
            let polished = '';
            for (let i = 0; i < polishChunks.length; i++) {
              const out = await generateWithProvider(model, effectiveApiKey, polishPrompt, polishChunks[i], {
                model: modelId,
                temperature: 0.45,
                topP: 0.90,
              });
              polished += (i > 0 ? '\n\n' : '') + out;
            }
            const polishGuard = applyRewriteRegressionGuard({
              originalText: currentText,
              candidateText: polished,
              fallbackText: currentText,
              minLexicalOverlap: 0.25,
              minLengthRatio: 0.75,
              maxLengthRatio: 1.30,
            });
            if (!polishGuard.usedFallback && polishGuard.text.trim()) {
              currentText = polishGuard.text;
              passes += 1;
            }
          } catch {
            // Keep Pass 1 output cleanly if Pass 2 provider call fails
          }
        }
      }

      // ==================== LAYER 4: Final Polish ====================
      if (enablePostprocess) {
        // Light post-process pass after chain
        currentText = postprocess(currentText, { light: true, synonymIntensity });
      }
    }

    // NOTE: Self-check loop disabled — multi-pass LLM self-checking adds more AI fingerprints
    // with each pass, making text MORE detectable, not less. Single-pass rewrite is more effective.
    // The code below is preserved but skipped.
    /*
    if (chainModelIds.length === 0) {
      for (let pass = 2; pass <= maxPasses; pass++) {
        const check = await llmSelfCheck(model, apiKey, currentText);
        if (check.score >= target) break;

        const allIssues = [...check.issues, ...check.flaggedSentences];
        if (allIssues.length === 0) break;

        try {
          const fixPrompt = getFixPrompt(allIssues);
          const fullFixPrompt = `${fixPrompt}\n\nORIGINAL TEXT TO FIX (rewrite the entire text with these fixes applied):\n\n${currentText}`;
          const result = await generateWithProvider(model, apiKey, fixPrompt, currentText, {
            model: modelId,
            temperature: params.temperature,
            topP: params.topP,
          });
          currentText = result;
          passes = pass;

          // Apply light post-processing after each self-check fix
          if (enablePostprocess) {
            currentText = postprocess(currentText, { light: true, style: style as any });
          }
        } catch { break; }
      }
    }
    */

    // Rudra: skip the regression guard's strict postprocessing-damage check
    // (no postprocessing happened) — use the original input as the lexical
    // baseline so gemma's faithful rewrite isn't penalized for changing words.
    // Also skip intensityPostprocess + ninja surgical rewrite — gemma already
    // delivers natural text and adding deterministic rewrites on top actively
    // hurts the detector score.
    let finalText: string;
    if (isRudraFree) {
      finalText = currentText;
    } else {
      const guard = applyRewriteRegressionGuard({
        // Compare the postprocessed candidate against the RAW LLM output, not the
        // user's original input. The guard's job is to catch POSTPROCESSING
        // damage (synonym/collocation swaps mangling the text), not to penalize
        // the LLM for rewriting — comparing against the original input made every
        // aggressive rewrite "fail" and revert, silently discarding all the
        // deterministic AI-footprint reduction. Baseline = raw LLM; revert only
        // if postprocessing drifts far from what the LLM itself produced.
        originalText: humanizedText,
        candidateText: currentText,
        fallbackText: safeClean(humanizedText),
        minLexicalOverlap: 0.35,
        minLengthRatio: 0.6,
        maxLengthRatio: 1.5,
      });
      finalText = guard.text;
      // Intensity-driven anti-detector pass (after the guard so it is never reverted).
      finalText = intensityPostprocess(finalText, intensity, { style: style as any });

      // Ninja: surgically rewrite ONLY the lowest-scoring sentences using the
      // OFFLINE local rehumanizer (no extra LLM pass -> no added fingerprints).
      // Targets the worst offenders; leaves already-good text untouched.
      const ninjaDetection = detectAI(finalText);
      if (intensity === 'ninja' && ninjaDetection.sentences.length > 0) {
        const worst = [...ninjaDetection.sentences]
          .sort((a, b) => a.score - b.score)
          .slice(0, 3)
          .filter((s) => s.score < 55 && s.text && s.text.trim().length > 20);
        const replacements = worst
          .map((s) => ({ original: s.text, replacement: localRehumanizeSentence(s.text) }))
          .filter((r) => r.replacement && r.replacement.trim() !== r.original.trim());
        if (replacements.length > 0) {
          finalText = replaceSentencesInText(finalText, replacements);
          finalText = intensityPostprocess(finalText, 'aggressive', { style: style as any });
        }
      }
      finalText = scrubAIText(finalText);
      if (protectedRegions.length > 0) {
        finalText = restoreRegions(finalText, protectedRegions);
      }
    }
    const finalDetection = detectAI(finalText);
    const confidenceReport = buildConfidenceReport(finalDetection.score);
    const runtimeModelScore = await scoreHumanLikeness(finalText);
    const semanticFidelity = assessSemanticFidelity(text, finalText);
    const sentences = buildSentenceResults(text, finalText).map((row, i) => ({
      original: row.original,
      humanized: row.humanized,
      alternatives: [] as string[],
      index: i,
      detectionScore: finalDetection.sentences[i]?.score,
    }));

    const responsePayload = {
      sentences, fullText: finalText, model, modelName: providerInfo?.name || model,
      wordCount: { input: countWords(text), output: countWords(finalText) },
      timestamp: Date.now(), passes, finalScore: finalDetection.score,
      options: { style, language },
      confidenceReport,
      runtimeModelScore,
      semanticFidelity,
      observability: {
        latencyMs: Date.now() - startedAt,
        estimatedCostUsd: estimateRunCost(countWords(text), countWords(finalText), model),
        streamingAvailable: true,
        privacyMode: false,
      },
      fallbackBehavior: {
        used: false,
        reason: isRudraFree ? 'skipped (rudra-free: no postprocessing)' : 'not needed',
      },
      provenanceDisclosure: {
        source: 'user-provided-input',
        policyVersion: 'pr7-safety-governance-v1',
        modelSelection: runtimeModelScore.modelSource,
      },
    };

    await appendAuditLog({
      timestamp: new Date().toISOString(),
      route: '/api/humanize',
      model,
      passes,
      inputWords: countWords(text),
      outputWords: countWords(finalText),
      finalScore: finalDetection.score,
      semanticScore: semanticFidelity.score,
      confidence: confidenceReport.confidence,
      fallbackUsed: false,
      runtimeModelSource: runtimeModelScore.modelSource,
      batchCount: Array.isArray(batchTexts) ? batchTexts.length : 0,
    });

    return NextResponse.json({ success: true, ...responsePayload });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
