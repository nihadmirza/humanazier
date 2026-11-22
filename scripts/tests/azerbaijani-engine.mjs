import test from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoSentences, isAzerbaijaniText, toLowerLocale } from '../../lib/text-utils';
import { getCorpusAwareSystemPrompt, getRehumanizePrompt, SAMPLE_AZ_AI_TEXT } from '../../lib/prompts';
import { getAzerbaijaniGrammarPrompt, getAzerbaijaniPolishPrompt } from '../../lib/prompts-az';
import { findAzerbaijaniRewriteIssues } from '../../lib/az-quality';
import { postprocess, stripAILexiconAZ } from '../../lib/postprocess';
import { detectAI, getDetailedDetectionReport } from '../../lib/detector';
import { localHumanizeText } from '../../lib/local-humanizer';
import { localRehumanizeSentence } from '../../lib/rehumanize';
import { checkGrammarLocally } from '../../lib/grammar';
import { assessSemanticFidelity } from '../../lib/semantic-fidelity';
import { evaluateMeaningRetention } from '../../lib/server/humanization-governance';
import { chunkText } from '../../lib/storage';
import { loadStyleModelAsync } from '../../lib/style-model';

test('splitIntoSentences splits Azerbaijani words ending in m/q/s/il/al while keeping real abbreviations', () => {
  const sentences = splitIntoSentences(
    'Mən bunu yazdım. Bu çox vacib olacaq. Yeni bir proses. Bu da təhlil. Növbəti cümlə.'
  );
  assert.equal(sentences.length, 5);
  assert.equal(sentences[0], 'Mən bunu yazdım.');
  assert.equal(sentences[1], 'Bu çox vacib olacaq.');
  assert.equal(sentences[2], 'Yeni bir proses.');
  assert.equal(sentences[3], 'Bu da təhlil.');
  assert.equal(sentences[4], 'Növbəti cümlə.');

  const withAbbr = splitIntoSentences('Bu yol 5 m. uzunluqdadır, məs. kənd yolu kimi. Sonra yeni hissə başlayır.');
  assert.equal(withAbbr.length, 2);

  const withVeS = splitIntoSentences('Meyvələrə alma, armud və s. daxildir. İkinci cümlə burada başlayır.');
  assert.equal(withVeS.length, 2);

  const veSAtEnd = splitIntoSentences('Meyvələr: alma, armud və s. Növbəti cümlə budur.');
  assert.equal(veSAtEnd.length, 2);
});

test('toLowerLocale and isAzerbaijaniText handle Azerbaijani Unicode letters cleanly', () => {
  assert.equal(toLowerLocale('İnkişaf və Işıq', true), 'inkişaf və ışıq');
  assert.equal(isAzerbaijaniText('Müasir dövrdə təhsil çox vacibdir.'), true);
  assert.equal(isAzerbaijaniText('Bu gün hava çox pis olacaq.'), true);
  assert.equal(isAzerbaijaniText('The quick brown fox jumps over the lazy dog.'), false);
});

test('getCorpusAwareSystemPrompt never leaks English corpus rules into Azerbaijani and respects intensity', async () => {
  await loadStyleModelAsync();
  const light = getCorpusAwareSystemPrompt('academic', undefined, undefined, 'az', undefined, 'light');
  const ninja = getCorpusAwareSystemPrompt('academic', undefined, undefined, 'az', undefined, 'ninja');

  assert.doesNotMatch(light, /CORPUS-CALIBRATED STYLE TARGETS/i);
  assert.doesNotMatch(light, /CONTRACTIONS/i);
  assert.match(light, /YÜNGÜL \/ LIGHT/);
  assert.match(ninja, /MAKSİMUM \/ NINJA/);
  assert.match(light, /NÜMUNƏ \(AKADEMİK/);
  assert.doesNotMatch(light, /təbiiiləşdir/);

  const rehum = getRehumanizePrompt(['Qeyd etmək vacibdir ki, bu üsul mühüm rol oynayır.'], 'academic');
  assert.match(rehum, /YENİDƏN YAZILACAQ CÜMLƏLƏR/);
  assert.doesNotMatch(rehum, /Use natural contractions/i);

  const gram = getAzerbaijaniGrammarPrompt();
  assert.match(gram, /ahəng qanunu/i);
});

test('postprocess strips Azerbaijani LLM preambles, sign-offs, AI clichés, and Turkish calques while preserving paragraphs', () => {
  const raw = `Əlbəttə, buyurun təbiiləşdirilmiş mətn:
Qeyd etmək vacibdir ki, bu sürəc gerçəkləşdirmək üçün önəmli özəllik daşıyır.

Nəticə etibarilə, bu uyğulama mühüm rol oynayır.
Ümid edirəm kömək etdi!`;

  const cleaned = postprocess(raw, { light: true, style: 'academic' });
  assert.doesNotMatch(cleaned, /Əlbəttə, buyurun/i);
  assert.doesNotMatch(cleaned, /Ümid edirəm/i);
  assert.doesNotMatch(cleaned, /qeyd etmək vacibdir ki/i);
  assert.doesNotMatch(cleaned, /gerçəkləşdirmək/i);
  assert.doesNotMatch(cleaned, /\bsürəc\b/i);
  assert.doesNotMatch(cleaned, /uyğulama/i);
  assert.doesNotMatch(cleaned, /özəllik/i);
  assert.match(cleaned, /proses/);
  assert.match(cleaned, /həyata keçirmək/);
  assert.match(cleaned, /tətbiq/);
  assert.match(cleaned, /xüsusiyyət/);
  assert.match(cleaned, /\n\n/, 'paragraph breaks must survive postprocessing');

  const stripped = stripAILexiconAZ('Bundan əlavə, bu sahədə mühüm rol oynayır.');
  assert.doesNotMatch(stripped, /həmçinin/i);
});

test('detectAI scores Azerbaijani AI text lower than natural prose and flags Turkish calques and quantifiers', () => {
  const aiReport = getDetailedDetectionReport(SAMPLE_AZ_AI_TEXT);
  assert.ok(aiReport.foundAiPhrases.includes('nəticə etibarilə'));
  assert.ok(aiReport.foundAiPhrases.includes('qeyd etmək vacibdir ki'));

  const calqueResult = detectAI('Bu sürəc çoxsaylı müxtəlif uyğulama ilə gerçəkləşdirmək üçün önəmli rol daşıyır — əla nəticədir.');
  assert.ok(calqueResult.analysis.quantifierOveruse > 0, 'AZ_QUANTIFIERS must match Unicode words');
  assert.ok(
    calqueResult.sentences[0].issues.some(i => i.includes('Türkiyə türkcəsi təsiri')),
    'Turkish calques should be flagged in Azerbaijani detection'
  );
  assert.ok(
    calqueResult.sentences[0].issues.some(i => i.includes('uzun tire')),
    'Em-dash should be flagged as an AI signal in Azerbaijani'
  );

  // Short Azerbaijani sentence without "ə" inside an Azerbaijani document should still get AZ analysis
  const mixedDoc = detectAI('Müasir dövrdə bu iş çox vacibdir. Bu gün hava yaxşıdır.');
  assert.equal(mixedDoc.sentences.length, 2);
});

test('localHumanizeText and localRehumanizeSentence work on Unicode Azerbaijani boundaries and respect formal style', () => {
  const input = 'Ümumilikdə, müasir dövrdə bu sistem həmişə əhəmiyyətli dərəcədə nəticə verir. Nəticə etibarilə, işlər sürətlənir.';
  const out = localHumanizeText(input, { style: 'academic' });
  assert.doesNotMatch(out, /ümumilikdə/i);
  assert.doesNotMatch(out, /müasir dövrdə/i);
  assert.doesNotMatch(out, /əhəmiyyətli dərəcədə/i);
  assert.doesNotMatch(out, /nəticə etibarilə/i);
  assert.doesNotMatch(out, /həmişə/i);
  assert.doesNotMatch(out, /Doğrusu,|Onu da deyim ki,/i);

  const rehum = localRehumanizeSentence('qeyd etmək vacibdir ki, bu sürəc mühüm rol oynayır.');
  assert.match(rehum, /^Bu /);
  assert.doesNotMatch(rehum, /qeyd etmək vacibdir ki/i);
  assert.match(rehum, /proses/);
});

test('checkGrammarLocally applies Azerbaijani rules instead of English rules', () => {
  const res = checkGrammarLocally('bu sürəc çox önəmli ,lakin gerçəkləşdirmək çətindir');
  assert.equal(res.source, 'local-fallback');
  assert.match(res.correctedText, /^Bu proses çox vacib, lakin həyata keçirmək çətindir\.$/);
  assert.ok(res.issues.length >= 3);
  assert.ok(res.issues.every(i => !/first-person pronoun/i.test(i.explanation)));
});

test('semantic fidelity and governance guard support Azerbaijani entities and negations', () => {
  const orig = 'Əliyev və Şuşa komandası 2026-cı ildə İqtisadiyyat layihəsini dayandırmadı, lakin nəticə hələ hazır deyil.';
  const flipped = 'Əliyev və Şuşa komandası 2026-cı ildə İqtisadiyyat layihəsini davam etdirdi, nəticə artıq hazırdır.';
  const report = assessSemanticFidelity(orig, flipped);
  assert.ok(report.negationConsistency < 100, 'Dropped Azerbaijani negation ("deyil") must lower negationConsistency');
  assert.equal(report.entityRecall, 100, 'Unicode uppercase Azerbaijani entities (Ə, Ş, İ) must match');

  const droppedEntity = assessSemanticFidelity(orig, 'Komanda 2026-cı ildə layihəni dayandırmadı, lakin nəticə hələ hazır deyil.');
  assert.ok(droppedEntity.entityRecall < 100, 'Dropping Əliyev/Şuşa/İqtisadiyyat must lower entityRecall');

  const retention = evaluateMeaningRetention(orig, orig);
  assert.equal(retention.keywordsPreserved, 1);
});

test('chunkText preserves paragraph breaks when splitting long texts', () => {
  const p1 = Array(30).fill('məlumat').join(' ') + '.';
  const p2 = Array(30).fill('təhlil').join(' ') + '.';
  const p3 = Array(30).fill('nəticə').join(' ') + '.';
  const text = `${p1}\n\n${p2}\n\n${p3}`;
  const chunks = chunkText(text, 70);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].includes('\n\n'), 'Paragraph separator inside chunk must be preserved');
});

test('LaTeX math blocks, inline math, and compound proper-noun en-dashes survive postprocess and localHumanizeText intact', () => {
  const sample = `FIR süzgəclərinin riyazi modeli aşağıdakı ifadə ilə göstərilir:
\\[
y[n]=\\sum_{k=0}^{N}h[k]x[n-k]
\\]

Burada \\(y[n]\\) çıxışı, \\(x[n]\\) girişi göstərir. Parks–McClellan alqoritmi geniş istifadə olunur.`;

  const pp = postprocess(sample, { light: true, style: 'academic' });
  const loc = localHumanizeText(sample, { style: 'academic' });

  for (const out of [pp, loc]) {
    assert.ok(out.includes('y[n]=\\sum_{k=0}^{N}h[k]x[n-k]'), 'Display LaTeX formula must stay verbatim (no Y[n] mangling)');
    assert.ok(out.includes('\\(y[n]\\)') && out.includes('\\(x[n]\\)'), 'Inline LaTeX math must stay verbatim');
    assert.ok(out.includes('Parks–McClellan'), 'Compound proper-noun en-dash must not become comma');
  }
});

test('silent Azerbaijani Pass-2 quality audit catches copied 5-grams, repetitive openers, calques, and passive overload', () => {
  const original = `FIR süzgəcləri müasir telekommunikasiya sistemlərinin əsas istiqamətlərindən biridir. FIR süzgəcləri sonlu impuls xarakteristikası ilə seçilir və geniş istifadə olunur. FIR süzgəcləri yüksək dəqiqliklə tətbiq edilir və siqnal emalında mühüm rol oynayır.`;
  const lazyRewrite = `FIR süzgəcləri müasir telekommunikasiya sistemlərinin əsas istiqamətlərindən biridir. FIR süzgəcləri sonlu impuls xarakteristikası ilə seçilir və bu sürəc geniş istifadə olunur. FIR süzgəcləri yüksək dəqiqliklə tətbiq edilir və mühüm rol oynayır.`;

  const badAudit = findAzerbaijaniRewriteIssues(original, lazyRewrite);
  assert.equal(badAudit.needsPolish, true);
  assert.ok(badAudit.verbatimSamples.length >= 3, 'Should detect copied 5-gram spans');
  assert.ok(badAudit.repetitiveOpeners.includes('FIR süzgəcləri'), 'Should catch repetitive 2-word openers');
  assert.ok(badAudit.issues.some(i => i.includes('Türkiyə türkcəsi')));

  const polishPrompt = getAzerbaijaniPolishPrompt(badAudit.issues, 'academic');
  assert.match(polishPrompt, /__PROTECT_N__/);
  assert.match(polishPrompt, /Elmi\/rəsmi registri/);

  const cleanRewrite = `Telekommunikasiya şəbəkələrində rəqəmsal siqnal emalı üçün sonlu impuls cavablı filtrlər tez-tez seçilir. Onların əsas üstünlüyü çıxışın yalnız məhdud sayda giriş nümunəsindən asılı olmasıdır. Bu mexanizm sistemin sabit işləməsinə kömək edir.`;
  const goodAudit = findAzerbaijaniRewriteIssues(original, cleanRewrite);
  assert.equal(goodAudit.needsPolish, false);
});
