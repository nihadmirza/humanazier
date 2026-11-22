// StealthHumanizer - Multi-Model Chaining (Layer 3)
// Chain rewrites through different LLM models to mix statistical fingerprints.

import { ModelProvider, StylePreset } from './types';
import { getProvider, resolveModelId } from './providers';
import { generateWithProvider } from './server/providers-runtime';
import { getSystemPrompt } from './prompts';
import { postprocess } from './postprocess';

export interface ChainOptions {
  text: string;
  chainModels: { provider: ModelProvider; apiKey: string }[];
  style: StylePreset;
  /** Resolved language ('az', 'zh-CN', ...). Without it every pass gets the English prompt. */
  language?: string;
  /** Same-language reminder appended to the text, as in the first rewrite pass. */
  langNote?: string;
  /** Per-provider model picks from Settings; validated by resolveModelId. */
  modelVariants?: Record<string, string>;
  onProgress?: (step: string, model: string) => void;
}

// Azerbaijani pass 2+: a conservative native-speaker edit instead of another
// full rewrite. Each extra rewrite in Azerbaijani adds its own calques and
// meaning drift; an editor pass fixes them instead.
const AZ_CHAIN_EDITOR_ROLE = `

=== ROL: DİL REDAKTORU (TƏKRAR KEÇİD) ===
Bu mətn artıq bir dəfə təbiiləşdirilib. Onu yenidən YAZMA. Ana dili Azərbaycan dili olan təcrübəli redaktor kimi yalnız bunları düzəlt:
- qrammatik, orfoqrafik və durğu işarəsi səhvləri;
- Türkiyə türkcəsinə məxsus söz və qəliblər (Azərbaycan ədəbi dilindəki qarşılığı ilə);
- ingilis dilindən hərfi tərcümə kimi səslənən ifadələr;
- mənaca yanlış işlənmiş sözlər.
Cümlə və abzas sayını, terminləri, düsturları, ədədləri və üslubu dəyişmə. Düzəliş tələb etməyən cümlələrə toxunma.`;

interface ChainResult {
  text: string;
  passes: { provider: ModelProvider; modelName: string }[];
}

/**
 * Chain rewrites through multiple LLM models.
 * Each model adds its own statistical fingerprint, making detection much harder.
 */
export async function chainModels(options: ChainOptions): Promise<ChainResult> {
  const { text, chainModels, style, language, langNote = '', modelVariants, onProgress } = options;
  
  let currentText = text;
  const passes: { provider: ModelProvider; modelName: string }[] = [];

  for (let i = 0; i < chainModels.length; i++) {
    const { provider, apiKey } = chainModels[i];
    const providerInfo = getProvider(provider);
    if (!providerInfo) continue;

    const modelName = providerInfo.name;
    const model = resolveModelId(provider, modelVariants?.[provider]);

    onProgress?.(`Step ${i + 1}: Chain through ${modelName}`, modelName);

    // Build a progressively lighter prompt for each chain pass
    // First pass: full rewrite. Later passes: lighter touch to avoid destroying content.
    let systemPrompt = getSystemPrompt(style, undefined, language);

    // Optimize multi-chain passes: Pass 1 is the Structural Editor, Pass 2+ is the Vocabulary Polisher
    if (i > 0 && language === 'az') {
      systemPrompt += AZ_CHAIN_EDITOR_ROLE;
    } else if (i > 0) {
      systemPrompt += `\n\n=== ROLE: POLISHING EDITOR ===\nThis text has already been structurally humanized. Your strict focus for this pass is on VOCABULARY ENHANCEMENT and PERFECT FLOW. Do not alter the paragraph lengths or sentence counts. Upgrade the verbs and adjectives to match a premium human standard (e.g., Q1 Journal or Executive level) while guaranteeing flawless grammar.`;
    }

    try {
      // Azerbaijani pass 2+ is a conservative native-speaker editor: use lower temperature
      // so it fixes calques/grammar cleanly instead of inventing drift.
      const isAzEditorPass = i > 0 && language === 'az';
      const result = await generateWithProvider(
        provider,
        apiKey,
        systemPrompt,
        currentText + langNote,
        {
          model,
          temperature: isAzEditorPass ? 0.45 : (0.85 + (i * 0.05)),
          topP: isAzEditorPass ? 0.90 : (0.92 + (i * 0.02)),
        }
      );

      currentText = result;
      passes.push({ provider, modelName });

      // Apply post-processing between chain passes (light version)
      if (i < chainModels.length - 1) {
        currentText = postprocess(currentText, { light: true, style });
      }
    } catch (err: unknown) {
      // If one model fails, skip it and continue with others
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Chain pass ${i + 1} (${modelName}) failed: ${msg}`);
    }
  }

  return { text: currentText, passes };
}
