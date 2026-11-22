// StealthHumanizer v2 - Advanced AI Detection Engine

import { DetectionResult, SentenceDetectionResult, DetailedDetectionReport } from './types';
import { calculateReadability } from './readability';
import type { CorpusStyleModel, CalibratedThresholds } from './style-model';
import { splitIntoSentences, isAzerbaijaniText, toLowerLocale } from './text-utils';

// ==================== PATTERN DATABASES ====================

const AI_PHRASES = [
  'it is important to note', 'it is worth mentioning', 'it is worth noting',
  'in conclusion', 'in summary', 'to summarize', 'to conclude',
  'furthermore', 'moreover', 'additionally', 'in addition',
  'it is crucial', 'it is essential', 'it is imperative',
  'plays a crucial role', 'plays an important role', 'plays a pivotal role',
  'has the potential to', 'it is evident that', 'it is clear that',
  'demonstrates the', 'illustrates the', 'showcases the',
  'underscores the', 'highlights the', 'emphasizes the',
  'on the other hand', 'in terms of', 'when it comes to',
  'as previously mentioned', 'as discussed earlier', 'as noted above',
  'it should be noted', 'it must be noted', 'needless to say',
  'last but not least', 'first and foremost', 'at the end of the day',
  'in today\'s world', 'in this day and age', 'in the modern era',
  'in the contemporary landscape', 'in the current landscape',
  'a myriad of', 'delve into', 'delves into',
  'tapestry of', 'navigating the landscape',
  'multifaceted', 'robust', 'seamless', 'streamline',
  'synergy', 'paradigm', 'paradigm shift', 'holistic',
  'innovative', 'cutting-edge', 'state-of-the-art', 'groundbreaking',
  'transformative', 'comprehensive', 'unprecedented',
  'utilize', 'facilitate', 'optimize', 'leverage',
  'implement', 'foster', 'cultivate', 'empower',
  'embark on a journey', 'sheds light on', 'brings to the forefront',
];

const AI_SENTENCE_STARTERS = [
  'In this article', 'This paper', 'This study', 'This research',
  'The results', 'The findings', 'The analysis', 'The data',
  'It is widely', 'It is commonly', 'There is a',
  'One of the', 'Another important', 'A key aspect',
  'The importance of', 'The significance of', 'The role of',
  'Research has shown', 'Studies have shown', 'Evidence suggests',
];

const HEDGING_PHRASES = [
  'it could be argued', 'one might consider', 'it is possible that',
  'it would seem', 'this suggests that', 'this may indicate',
  'it appears that', 'this could potentially', 'one could argue',
];

const QUANTIFIERS = [
  'numerous', 'various', 'multiple', 'several', 'a variety of',
  'a multitude of', 'a range of', 'a number of', 'countless',
  'a vast array of', 'a wide range of', 'a significant number of',
];

const TRANSITION_WORDS = [
  'however', 'therefore', 'moreover', 'furthermore', 'additionally',
  'consequently', 'nevertheless', 'meanwhile', 'subsequently', 'thus',
  'hence', 'accordingly', 'similarly', 'likewise', 'conversely',
  'otherwise', 'instead', 'rather', 'yet', 'still', 'moreover',
];

const HUMAN_INDICATORS = [
  'basically', 'actually', 'literally', 'honestly', 'like',
  'you know', 'I mean', 'kind of', 'sort of', 'pretty much',
  'I think', 'I feel like', 'I guess', 'I\'d say', 'to be honest',
  'weirdly', 'interestingly', 'funnily enough', 'surprisingly',
  'anyway', 'so yeah', 'I dunno', 'tbh', 'imo',
];

// Arabic-specific patterns
const AR_AI_PHRASES = [
  'من المهم أن نلاحظ', 'من الجدير بالذكر', 'من الضروري أن',
  'في الختام', 'بصورة عامة', 'لذلك', 'بالإضافة إلى ذلك',
  'من ناحية أخرى', 'في الواقع', 'في العصر الحديث',
  'تلعب دوراً هاماً', 'من الضروري الإشارة إلى', 'في هذا الصدد',
  'من خلال هذا المقال', 'نتيجة لذلك', 'علاوة على ذلك',
  'كما هو معروف', 'من منظور', 'في ضوء ذلك',
];

const AR_AI_SENTENCE_STARTERS = [
  'في هذا المقال', 'تظهر النتائج', 'تشير الدراسات',
  'من الواضح أن', 'في ضوء', 'بناءً على',
  'يمكن القول إن', 'من الملاحظ أن', 'تهدف هذه الدراسة',
];

const AR_HUMAN_INDICATORS = [
  'يعني', 'بصراحة', 'صحيح', 'طيب', 'عموماً',
  'الحمد لله', 'ما أدري', 'على فكرة', 'بس', 'بالتالي',
  'يا جماعة', 'أنا فكرت', 'بكل صراحة', 'والله', 'يعني كذا',
  'طبعاً', 'مو', 'ليش', 'إيش', 'وش',
];

const AR_TRANSITION_WORDS = [
  'ومع ذلك', 'لذلك', 'بالإضافة', 'نتيجة لذلك', 'علاوة على ذلك',
  'من جهة أخرى', 'في المقابل', 'بشكل عام', 'أخيراً', 'أولاً',
];

// Azerbaijani-specific patterns
const AZ_AI_PHRASES = [
  'qeyd etmək vacibdir ki', 'qeyd etmək lazımdır ki', 'qeyd etmək vacibdir',
  'qeyd etmək lazımdır', 'xüsusilə qeyd etmək lazımdır ki', 'xüsusilə qeyd etmək lazımdır',
  'xüsusilə vurğulamaq lazımdır ki', 'xüsusilə vurğulamaq lazımdır',
  'nəzərə almaq lazımdır ki', 'nəzərə almaq lazımdır', 'mühüm rol oynayır',
  'əsas rol oynayır', 'həlledici rol oynayır', 'mühüm əhəmiyyət kəsb edir',
  'həlledici əhəmiyyət kəsb edir', 'böyük əhəmiyyət kəsb edir', 'böyük əhəmiyyət daşıyır',
  'mühüm əhəmiyyət daşıyır', 'xüsusi əhəmiyyətə malikdir',
  'əsas istiqamətlərindən biridir', 'mühüm vasitələrdən biri',
  'ən mühüm üstünlüklərindən biri', 'digər mühüm üstünlük',
  'geniş istifadə olunur', 'geniş tətbiq sahələri yaradır',
  'aktual tədqiqat istiqamətlərindəndir', 'müsbət təsir göstərir',
  'başqa sözlə', 'bu düsturdan göründüyü kimi', 'imkan verəcəkdir',
  'nəticə olaraq', 'nəticə etibarilə', 'yekun olaraq',
  'xülasə olaraq', 'ümumiləşdirsək', 'son olaraq',
  'müasir dünyada', 'müasir dövrdə', 'bugünkü dünyada', 'rəqəmsal əsrdə',
  'qloballaşan dünyada', 'bir tərəfdən', 'digər tərəfdən',
  'bununla yanaşı', 'bundan əlavə', 'eyni zamanda', 'öz növbəsində',
  'əhəmiyyətli dərəcədə', 'görünməmiş irəliləyiş', 'əsas məqsəd ondan ibarətdir ki',
  'özündə ehtiva edir', 'geniş spektr', 'böyük potensiala malikdir',
  'aydındır ki', 'şübhəsiz ki', 'məlum olduğu kimi',
  'tədqiqatlar göstərir ki', 'sübut edilmişdir ki', 'araşdırmalar göstərir ki',
  'dərinliklərinə enək', 'nəzər salaq', 'işıq salaq', 'diqqət yetirək',
  'əvəzolunmaz rol', 'töhfə verir', 'imkan yaradır', 'şərait yaradır',
  'açıq-aydın görünür', 'inkaredilməzdir ki', 'əminliklə demək olar ki',
  'qarşıya qoyulan məqsəd', 'zəngin təcrübə', 'böyük sıçrayış',
];

// Turkish (Türkiye) calques that LLMs frequently leak into Azerbaijani text
const AZ_TURKISH_CALQUES = [
  'gerçəkləşdirmək', 'gerçəkləşdirilir', 'gerçəkləşdirir',
  'önəmli', 'özəllik', 'özəlliklər', 'özəllikləri',
  'sürəc', 'sürəci', 'sürəclər', 'sürəcdə',
  'düzəy', 'düzəyi', 'düzəydə',
  'uyğulama', 'uyğulamalar', 'uyğulanır',
  'gəlişmiş', 'dəyərləndirmək', 'dəyərləndirilir', 'örtüşən',
];

const AZ_AI_SENTENCE_STARTERS = [
  'bu məqalədə', 'bu araşdırmada', 'bu yazıda', 'bu tədqiqatda',
  'nəticələr göstərir ki', 'tədqiqatlar göstərir ki', 'araşdırmalar sübut edir ki',
  'qeyd etmək lazımdır ki', 'qeyd etmək vacibdir ki', 'aydındır ki',
  'şübhəsiz ki', 'məlum olduğu kimi', 'ilk növbədə', 'ümumiyyətlə',
];

const AZ_HUMAN_INDICATORS = [
  'əslində', 'açığı', 'doğrusu', 'düzü', 'məncə', 'mənə elə gəlir ki',
  'deyəsən', 'bəlkə də', 'yeri gəlmişkən', 'maraqlıdır ki', 'təbii ki',
  'əlbəttə', 'belə baxanda', 'demək olar ki', 'bir növ', 'hər halda',
  'sözün düzü', 'görünən odur ki', 'zarafat deyil',
];

const AZ_TRANSITION_WORDS = [
  'lakin', 'ancaq', 'amma', 'bununla belə', 'buna baxmayaraq',
  'həmçinin', 'bundan əlavə', 'nəticədə', 'beləliklə', 'əksinə',
  'halbuki', 'bunun müqabilində', 'eyni zamanda',
];

const AZ_PRONOUNS = [
  'mən', 'mənim', 'mənə', 'məni', 'məndə', 'məndən',
  'biz', 'bizim', 'bizə', 'bizi', 'bizdə', 'bizdən',
  'sən', 'sənin', 'sənə', 'səni', 'səndə', 'səndən',
  'siz', 'sizin', 'sizə', 'sizi', 'sizdə', 'sizdən',
];

const AZ_HEDGING_PHRASES = [
  'ehtimal olunur ki', 'güman edilir ki', 'belə görünür ki',
  'mümkündür ki', 'iddia edilə bilər ki', 'belə demək mümkünsə',
  'fərz etmək olar ki',
];

const AZ_QUANTIFIERS = [
  'bir sıra', 'çoxsaylı', 'müxtəlif', 'geniş çeşiddə', 'saysız-hesabsız',
  'böyük miqdarda', 'çoxlu sayda', 'müəyyən qədər',
];

// ==================== CORE ANALYSIS FUNCTIONS ====================

// `\b` and `\w` are ASCII-only in JS, so they break on Azerbaijani letters
// (ə, ı, ş, ç, ğ, ö, ü): "\bmən\b" also matches inside "əmən...", and
// "[^\w\s]" strips those letters out of words. Use Unicode-aware boundaries.
function azTermRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
}

function countAzTerm(lower: string, term: string): number {
  return (lower.match(azTermRegex(term)) || []).length;
}

function calculatePerplexity(text: string): number {
  const words = text.toLowerCase().split(/\s+/);
  if (words.length < 5) return 50;
  const freq: Record<string, number> = {};
  words.forEach(w => freq[w] = (freq[w] || 0) + 1);
  const values = Object.values(freq);
  const maxFreq = Math.max(...values);
  const avgFreq = words.length / values.length;
  const uniformity = maxFreq / avgFreq;
  // N-gram analysis for perplexity
  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) bigrams.push(words[i] + ' ' + words[i + 1]);
  const bigramFreq: Record<string, number> = {};
  bigrams.forEach(b => bigramFreq[b] = (bigramFreq[b] || 0) + 1);
  const uniqueBigrams = Object.keys(bigramFreq).length;
  const bigramDiversity = uniqueBigrams / bigrams.length;
  // Higher diversity + lower uniformity = higher perplexity (more human)
  const score = (bigramDiversity * 60) + ((100 - uniformity * 15) * 0.4);
  return Math.min(100, Math.max(0, score));
}

function calculateBurstiness(sentences: string[]): number {
  if (sentences.length < 3) return 50;
  const lengths = sentences.map(s => s.split(/\s+/).length);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((sum, len) => sum + Math.pow(len - avg, 2), 0) / lengths.length;
  const stdDev = Math.sqrt(variance);
  const burstiness = (stdDev / avg) * 100;
  return Math.min(100, burstiness * 2.5);
}

function calculateVocabularyDiversity(text: string): number {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(w => w.length > 2);
  if (words.length < 10) return 50;
  return (new Set(words).size / words.length) * 100;
}

function calculateSentenceLengthVariation(sentences: string[]): number {
  if (sentences.length < 3) return 50;
  const lengths = sentences.map(s => s.split(/\s+/).length);
  const max = Math.max(...lengths);
  const min = Math.min(...lengths);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  return Math.min(100, ((max - min) / avg) * 60);
}

function calculateTransitionFrequency(text: string): number {
  const isAz = isAzerbaijaniText(text);
  const lower = toLowerLocale(text, isAz);
  const words = lower.split(/\s+/);
  if (words.length < 10) return 50;
  let count = 0;
  if (isAz) {
    AZ_TRANSITION_WORDS.forEach(w => { count += countAzTerm(lower, w); });
    return Math.min(100, (count / words.length) * 1000);
  }
  TRANSITION_WORDS.forEach(w => {
    const regex = new RegExp(`\\b${w}\\b`, 'gi');
    const matches = lower.match(regex);
    if (matches) count += matches.length;
  });
  return Math.min(100, (count / words.length) * 1000);
}

function calculatePassiveVoiceRatio(text: string): number {
  const sentences = splitIntoSentences(text);
  if (sentences.length < 2) return 50;

  const isAz = isAzerbaijaniText(text);
  if (isAz) {
    const azPassivePattern = /(?<!\p{L})\p{L}+(?:ıl|il|ul|ül|ın|in|un|ün)(?:dı|di|du|dü|mış|miş|muş|müş|ır|ir|ur|ür|acaq|əcək|maqdadır|məkdədir)(?!\p{L})/giu;
    let azPassiveCount = 0;
    sentences.forEach(s => {
      const m = s.match(azPassivePattern);
      if (m) azPassiveCount += m.length;
    });
    return Math.min(100, (azPassiveCount / sentences.length) * 100);
  }

  const patterns = [
    /\b(is|are|was|were|been|being)\s+\w+ed\b/gi,
    /\b(is|are|was|were|been|being)\s+\w+en\b/gi,
  ];
  let passiveCount = 0;
  sentences.forEach(s => patterns.forEach(p => {
    const m = s.match(p); if (m) passiveCount += m.length;
  }));
  return Math.min(100, (passiveCount / sentences.length) * 100);
}

function calculateAIPhraseDensity(text: string): number {
  const isAz = isAzerbaijaniText(text);
  const lower = toLowerLocale(text, isAz);
  let count = 0;
  if (!isAz) {
    AI_PHRASES.forEach(phrase => { if (lower.includes(phrase)) count++; });
  }
  // Arabic AI phrases
  const isArabic = /[؀-ۿ]/.test(text);
  if (isArabic) {
    AR_AI_PHRASES.forEach(phrase => { if (text.includes(phrase)) count++; });
  }
  // Azerbaijani AI phrases + Turkish calques (count actual occurrences, not just unique types)
  if (isAz) {
    AZ_AI_PHRASES.forEach(phrase => { count += countAzTerm(lower, phrase); });
    AZ_TURKISH_CALQUES.forEach(calque => { count += countAzTerm(lower, calque) * 0.5; });
    return Math.min(100, (count / Math.max(splitIntoSentences(text).length, 1)) * 65);
  }
  return Math.min(100, (count / Math.max(splitIntoSentences(text).length, 1)) * 20);
}

function calculateSentenceStartDiversity(sentences: string[], isAz = false): number {
  if (sentences.length < 4) return 50;
  const starts = sentences.map(s => toLowerLocale(s.split(/\s+/)[0] || '', isAz).replace(/[^\p{L}]/gu, ''));
  const uniqueStarts = new Set(starts);
  return (uniqueStarts.size / starts.length) * 100;
}

function calculatePronounUsage(text: string): number {
  const isAz = isAzerbaijaniText(text);
  const words = toLowerLocale(text, isAz).split(/\s+/);
  let count = 0;
  if (isAz) {
    words.forEach(w => { if (AZ_PRONOUNS.includes(w.replace(/[^\p{L}]/gu, ''))) count++; });
  } else {
    const personalPronouns = ['i', 'me', 'my', 'we', 'us', 'our', 'you', 'your'];
    words.forEach(w => { if (personalPronouns.includes(w)) count++; });
  }
  const ratio = (count / Math.max(words.length, 1)) * 500;
  return Math.min(100, ratio);
}

function calculateHedgingFrequency(text: string): number {
  const isAz = isAzerbaijaniText(text);
  const lower = toLowerLocale(text, isAz);
  let count = 0;
  if (isAz) {
    AZ_HEDGING_PHRASES.forEach(phrase => { if (lower.includes(phrase)) count++; });
  } else {
    HEDGING_PHRASES.forEach(phrase => { if (lower.includes(phrase)) count++; });
  }
  return Math.min(100, count * 15);
}

function calculateQuantifierOveruse(text: string): number {
  const isAz = isAzerbaijaniText(text);
  const lower = toLowerLocale(text, isAz);
  let count = 0;
  if (isAz) {
    AZ_QUANTIFIERS.forEach(q => { count += countAzTerm(lower, q); });
    return Math.min(100, count * 10);
  }
  QUANTIFIERS.forEach(q => {
    const regex = new RegExp(`\\b${q}\\b`, 'gi');
    const m = lower.match(regex); if (m) count += m.length;
  });
  return Math.min(100, count * 10);
}

// ==================== SENTENCE-LEVEL ANALYSIS ====================

function analyzeSentence(sentence: string, docIsAz = false): SentenceDetectionResult {
  const issues: string[] = [];
  let score = 50;

  const isAz = docIsAz || isAzerbaijaniText(sentence);
  const lower = toLowerLocale(sentence, isAz);

  // Arabic detection
  const isArabic = /[؀-ۿ]/.test(sentence);

  if (isArabic) {
    // Arabic AI phrases
    AR_AI_PHRASES.forEach(phrase => {
      if (sentence.includes(phrase)) { score -= 12; issues.push(`AI phrase: "${phrase}"`); }
    });
    // Arabic AI sentence starters
    AR_AI_SENTENCE_STARTERS.forEach(starter => {
      if (sentence.startsWith(starter)) { score -= 8; issues.push('AI-like sentence opener (Arabic)'); }
    });
    // Arabic transition words
    AR_TRANSITION_WORDS.forEach(w => {
      if (sentence.includes(w)) { score -= 5; }
    });
    // Arabic human indicators (positive)
    AR_HUMAN_INDICATORS.forEach(h => { if (sentence.includes(h)) score += 5; });

    score = Math.max(0, Math.min(100, score));
    let classification: 'human' | 'maybe' | 'ai';
    const sFloor = calibratedThresholds?.humanScoreMin ?? 55;
    const sMid = Math.max(20, sFloor - 20);
    if (score >= sFloor) classification = 'human';
    else if (score >= sMid) classification = 'maybe';
    else classification = 'ai';
    return { text: sentence, score, classification, issues };
  }

  // Azerbaijani detection
  if (isAz) {
    AZ_AI_PHRASES.forEach(phrase => {
      if (lower.includes(phrase)) { score -= 12; issues.push(`AI şablon fraza: "${phrase}"`); }
    });
    AZ_TURKISH_CALQUES.forEach(calque => {
      if (countAzTerm(lower, calque) > 0) { score -= 6; issues.push(`Türkiyə türkcəsi təsiri: "${calque}"`); }
    });
    AZ_AI_SENTENCE_STARTERS.forEach(starter => {
      if (lower.startsWith(starter.toLocaleLowerCase('az-AZ'))) { score -= 8; issues.push('AI tipli cümlə başlanğıcı'); }
    });
    AZ_TRANSITION_WORDS.forEach(w => {
      if (countAzTerm(lower, w) > 0) { score -= 4; }
    });
    AZ_HUMAN_INDICATORS.forEach(h => { if (countAzTerm(lower, h) > 0) score += 6; });
    AZ_PRONOUNS.forEach(p => {
      if (countAzTerm(lower, p) > 0) score += 3;
    });

    const azWordCount = sentence.split(/\s+/).length;
    if (azWordCount > 35) { issues.push('Həddindən artıq uzun cümlə'); score -= 8; }
    else if (azWordCount <= 7 && azWordCount >= 2) { score += 5; }

    if (sentence.endsWith('?')) score += 4;
    if (sentence.endsWith('!')) score += 3;
    if (sentence.includes('—')) { score -= 3; issues.push('AI tipli uzun tire (—)'); }

    score = Math.max(0, Math.min(100, score));
    let classification: 'human' | 'maybe' | 'ai';
    const sFloor = calibratedThresholds?.humanScoreMin ?? 55;
    const sMid = Math.max(20, sFloor - 20);
    if (score >= sFloor) classification = 'human';
    else if (score >= sMid) classification = 'maybe';
    else classification = 'ai';
    return { text: sentence, score, classification, issues };
  }

  // AI phrases (heavy penalty)
  let aiPhraseCount = 0;
  AI_PHRASES.forEach(phrase => {
    if (lower.includes(phrase)) { aiPhraseCount++; issues.push(`AI phrase: "${phrase}"`); }
  });
  score -= aiPhraseCount * 12;

  // AI sentence starters
  AI_SENTENCE_STARTERS.forEach(starter => {
    if (lower.startsWith(starter.toLowerCase())) {
      score -= 8;
      issues.push(`AI-like sentence opener`);
    }
  });

  // Sentence length
  const wordCount = sentence.split(/\s+/).length;
  if (wordCount > 40) { issues.push('Very long sentence'); score -= 10; }
  else if (wordCount > 30) { issues.push('Long sentence (AI tendency)'); score -= 5; }
  if (wordCount <= 8 && wordCount >= 2) { score += 5; } // Short sentences are human-like

  // Formal vocabulary
  if (/\b(utilize|facilitate|leverage|foster|cultivate|empower)\b/i.test(sentence)) {
    issues.push('Formal/AI vocabulary'); score -= 8;
  }

  // Passive voice
  if (/\b(is|are|was|were|been|being)\s+\w+ed\b/i.test(sentence)) {
    issues.push('Passive voice'); score -= 3;
  }

  // Hedging
  HEDGING_PHRASES.forEach(h => {
    if (lower.includes(h)) { issues.push('Hedging language'); score -= 6; }
  });

  // Quantifiers
  QUANTIFIERS.forEach(q => {
    if (lower.includes(q)) { score -= 4; }
  });

  // Human indicators (positive signals) — reduced weight as these are weak signals
  let humanSignals = 0;
  HUMAN_INDICATORS.forEach(h => { if (lower.includes(h)) humanSignals++; });
  score += humanSignals * 3;

  // Contractions (human signal) — length-limited to prevent ReDoS
  const contractions = sentence.match(/[a-zA-Z]{1,15}'(?:t|s|re|ve|ll|d|m)\b/gi);
  if (contractions) score += contractions.length * 3;

  // First person (human signal)
  if (/\b(I|me|my|we|us|our)\b/i.test(sentence)) { score += 3; }

  // Second person
  if (/\byou\b/i.test(sentence)) { score += 2; }

  // Questions (human signal)
  if (sentence.endsWith('?')) { score += 4; }

  // Exclamation
  if (sentence.endsWith('!')) { score += 3; }

  // Em-dashes (human signal)
  if (sentence.includes('—') || sentence.includes(' - ')) { score += 2; }

  // Parenthetical asides
  if (sentence.includes('(') && sentence.includes(')')) { score += 3; }

  // Starts with conjunction
  if (/^(and|but|so|because|also|plus|or|well|ok|hey)\b/i.test(sentence)) { score += 4; }

  // Uniform structure penalty
  // Uniform structure penalty: only apply to sentences that are suspiciously
  // "perfect" — exactly medium length, no contractions, no parentheticals,
  // no dashes, no questions/exclamations. The previous condition was far too
  // broad and penalised ALL normal sentences.
  const words = sentence.split(/\s+/);
  if (words.length >= 12 && words.length <= 22
    && words.every(w => /^[\w,.]+$/.test(w))
    && /\.$/.test(sentence)
    && !contractions?.length
    && !/[()\[\]—]/.test(sentence)
    && humanSignals === 0) {
    issues.push('Uniform structure'); score -= 8;
  }

  score = Math.max(0, Math.min(100, score));

  let classification: 'human' | 'maybe' | 'ai';
  const sFloor = calibratedThresholds?.humanScoreMin ?? 55;
  const sMid = Math.max(20, sFloor - 20);
  if (score >= sFloor) classification = 'human';
  else if (score >= sMid) classification = 'maybe';
  else classification = 'ai';

  return { text: sentence, score, classification, issues };
}

// ==================== MAIN DETECTION FUNCTION ====================

/** Corpus-calibrated thresholds (set via calibrateWithCorpus) */
let calibratedThresholds: CalibratedThresholds | null = null;

/**
 * Calibrate the detector against corpus statistics.
 * Adjusts weights and thresholds based on real human writing patterns.
 */
export function calibrateWithCorpus(styleModel: CorpusStyleModel): CalibratedThresholds {
  const burstinessFloor = Math.round(styleModel.burstinessProfile.mean * 50);
  const vocabularyFloor = Math.round(styleModel.vocabularyDiversityRange.mean * 85);
  const totalTransitions = Object.values(styleModel.transitionWordFrequency)
    .reduce((sum, v) => sum + v, 0);
  const transitionCeiling = Math.round(totalTransitions * 200);

  calibratedThresholds = {
    humanScoreMin: 55,
    humanScoreMax: 95,
    humanScoreMedian: 70,
    targetScore: 75,
    burstinessFloor,
    vocabularyFloor,
    transitionCeiling,
  };
  return calibratedThresholds;
}

/**
 * Get the realistic score range for human writing based on corpus analysis.
 */
export function getHumanScoreRange(): { min: number; max: number; median: number } {
  if (calibratedThresholds) {
    return {
      min: calibratedThresholds.humanScoreMin,
      max: calibratedThresholds.humanScoreMax,
      median: calibratedThresholds.humanScoreMedian,
    };
  }
  return { min: 50, max: 90, median: 70 };
}

export function detectAI(text: string): DetectionResult {
  const isAz = isAzerbaijaniText(text);
  // Strip display LaTeX blocks when computing sentence/burstiness metrics so
  // equation lines (e.g. `\[ y[n]=... \]`) don't artificially inflate length variation.
  const proseForStats = text.replace(/\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/g, ' ');
  const sentences = splitIntoSentences(proseForStats);
  const sentenceResults = sentences.map(s => analyzeSentence(s, isAz));

  const perplexity = calculatePerplexity(proseForStats);
  const burstiness = calculateBurstiness(sentences);
  const vocabularyDiversity = calculateVocabularyDiversity(proseForStats);
  const sentenceLengthVariation = calculateSentenceLengthVariation(sentences);
  const transitionFrequency = calculateTransitionFrequency(proseForStats);
  const passiveVoiceRatio = calculatePassiveVoiceRatio(proseForStats);
  const aiPhraseDensity = calculateAIPhraseDensity(proseForStats);
  const sentenceStartDiversity = calculateSentenceStartDiversity(sentences, isAz);
  const pronounUsage = calculatePronounUsage(proseForStats);
  const hedgingFrequency = calculateHedgingFrequency(proseForStats);
  const quantifierOveruse = calculateQuantifierOveruse(proseForStats);

  const weights = {
    sentenceAvg: 0.25,
    perplexity: 0.15,
    burstiness: 0.15,
    vocabulary: 0.05,
    sentenceVariation: 0.08,
    transitions: 0.08,
    passive: 0.05,
    aiPhrases: 0.12,
    sentenceStart: 0.05,
    pronoun: 0.03,
    hedging: 0.03,
    quantifier: 0.02,
  };

  const sentenceAvg = sentenceResults.length > 0
    ? sentenceResults.reduce((s, r) => s + r.score, 0) / sentenceResults.length : 50;

  const overallScore = (
    sentenceAvg * weights.sentenceAvg +
    perplexity * weights.perplexity +
    burstiness * weights.burstiness +
    vocabularyDiversity * weights.vocabulary +
    sentenceLengthVariation * weights.sentenceVariation +
    (100 - transitionFrequency) * weights.transitions +
    (100 - passiveVoiceRatio) * weights.passive +
    (100 - aiPhraseDensity) * weights.aiPhrases +
    sentenceStartDiversity * weights.sentenceStart +
    pronounUsage * weights.pronoun +
    (100 - hedgingFrequency) * weights.hedging +
    (100 - quantifierOveruse) * weights.quantifier
  );

  let overallVerdict: 'human' | 'ai' | 'mixed';
  const humanFloor = calibratedThresholds?.humanScoreMin ?? 55;
  const mixedFloor = Math.max(20, humanFloor - 20);
  if (overallScore >= humanFloor) overallVerdict = 'human';
  else if (overallScore >= mixedFloor) overallVerdict = 'mixed';
  else overallVerdict = 'ai';

  // Confidence interval: wider when fewer sentences or high metric variance
  const sentenceScoreVariance = sentenceResults.length > 1
    ? sentenceResults.reduce((sum, r) => sum + Math.pow(r.score - overallScore, 2), 0) / sentenceResults.length
    : 400;
  const margin = Math.min(15, Math.round(Math.sqrt(sentenceScoreVariance) * 0.6 + (sentenceResults.length < 5 ? 6 : 2)));
  const confidenceInterval = {
    lower: Math.max(0, Math.round(overallScore - margin)),
    upper: Math.min(100, Math.round(overallScore + margin)),
  };

  return {
    score: Math.round(overallScore),
    confidenceInterval,
    sentences: sentenceResults,
    overallVerdict,
    analysis: {
      perplexity: Math.round(perplexity),
      burstiness: Math.round(burstiness),
      vocabularyDiversity: Math.round(vocabularyDiversity),
      sentenceLengthVariation: Math.round(sentenceLengthVariation),
      transitionFrequency: Math.round(transitionFrequency),
      passiveVoiceRatio: Math.round(passiveVoiceRatio),
      aiPhraseDensity: Math.round(aiPhraseDensity),
      sentenceStartDiversity: Math.round(sentenceStartDiversity),
      pronounUsage: Math.round(pronounUsage),
      hedgingFrequency: Math.round(hedgingFrequency),
      quantifierOveruse: Math.round(quantifierOveruse),
    },
    readability: calculateReadability(text),
  };
}

// ==================== DETAILED REPORT ====================

export function getDetailedDetectionReport(text: string): DetailedDetectionReport {
  const result = detectAI(text);
  const { sentences, analysis, score, confidenceInterval, overallVerdict } = result;

  // Top 5 most AI-like sentences
  const sortedAsc = [...sentences].sort((a, b) => a.score - b.score);
  const topAiSentences = sortedAsc.slice(0, 5).map(s => ({
    text: s.text.length > 120 ? s.text.slice(0, 117) + '...' : s.text,
    score: s.score,
    issues: s.issues,
  }));

  // Top 5 most human-like sentences
  const sortedDesc = [...sentences].sort((a, b) => b.score - a.score);
  const topHumanSentences = sortedDesc.slice(0, 5).map(s => ({
    text: s.text.length > 120 ? s.text.slice(0, 117) + '...' : s.text,
    score: s.score,
    issues: s.issues,
  }));

  // Found AI phrases in text
  const isAz = isAzerbaijaniText(text);
  const lower = toLowerLocale(text, isAz);
  const foundAiPhrases: string[] = [];
  if (!isAz) {
    AI_PHRASES.forEach(phrase => {
      if (lower.includes(phrase)) foundAiPhrases.push(phrase);
    });
  }
  // Arabic AI phrases
  const isArabic = /[؀-ۿ]/.test(text);
  if (isArabic) {
    AR_AI_PHRASES.forEach(phrase => {
      if (text.includes(phrase)) foundAiPhrases.push(phrase);
    });
  }
  // Azerbaijani AI phrases + Turkish calques
  if (isAz) {
    AZ_AI_PHRASES.forEach(phrase => {
      if (lower.includes(phrase)) foundAiPhrases.push(phrase);
    });
    AZ_TURKISH_CALQUES.forEach(calque => {
      if (countAzTerm(lower, calque) > 0) foundAiPhrases.push(calque);
    });
  }

  // Metrics summary with human-readable interpretations
  const metricsSummary = [
    { name: 'Perplexity', value: analysis.perplexity, interpretation: analysis.perplexity >= 55 ? 'Good diversity' : 'Low diversity (AI-like)' },
    { name: 'Burstiness', value: analysis.burstiness, interpretation: analysis.burstiness >= 40 ? 'Good variation' : 'Uniform lengths (AI-like)' },
    { name: 'Vocabulary Diversity', value: analysis.vocabularyDiversity, interpretation: analysis.vocabularyDiversity >= 60 ? 'Rich vocabulary' : 'Repetitive vocabulary' },
    { name: 'Sentence Variation', value: analysis.sentenceLengthVariation, interpretation: analysis.sentenceLengthVariation >= 40 ? 'Good length variation' : 'Uniform sentence lengths' },
    { name: 'AI Phrase Density', value: analysis.aiPhraseDensity, interpretation: analysis.aiPhraseDensity <= 15 ? 'Low AI phrasing' : 'High AI phrasing detected' },
    { name: 'Passive Voice', value: analysis.passiveVoiceRatio, interpretation: analysis.passiveVoiceRatio <= 20 ? 'Acceptable passive use' : 'Excessive passive voice' },
    { name: 'Transition Frequency', value: analysis.transitionFrequency, interpretation: analysis.transitionFrequency <= 12 ? 'Natural transitions' : 'Over-use of transitions' },
    { name: 'Sentence Start Diversity', value: analysis.sentenceStartDiversity, interpretation: analysis.sentenceStartDiversity >= 60 ? 'Diverse openers' : 'Repetitive sentence openers' },
  ];

  // Actionable recommendations
  const recommendations: string[] = [];
  if (isAz) {
    if (analysis.aiPhraseDensity > 15) recommendations.push('"Qeyd etmək vacibdir ki", "mühüm rol oynayır", "müasir dövrdə" kimi AI şablon ifadələrini mətndən çıxarın');
    if (analysis.burstiness < 40) recommendations.push('Cümlə uzunluqlarını kəskin dəyişin — qısa və lakonik cümlələrlə geniş cümlələri növbələşdirin');
    if (analysis.perplexity < 55) recommendations.push('Daha zəngin və gözlənilməz sözlərdən, canlı Azərbaycan frazeologiyasından istifadə edin');
    if (analysis.sentenceStartDiversity < 60) recommendations.push('Cümlələri fərqli başlayın — hər cümləni eyni bağlayıcılarla başlamaqdan çəkinin');
    if (analysis.passiveVoiceRatio > 20) recommendations.push('Məchul növdə olan quru felləri ("həyata keçirilir", "təmin olunur") fəal formaya çevirin');
    if (analysis.transitionFrequency > 12) recommendations.push('Formal bağlayıcıların ("lakin", "həmçinin", "bundan əlavə") sayını azaldın');
    if (analysis.hedgingFrequency > 20) recommendations.push('Şablon ehtimal ifadələrini ("güman edilir ki", "ehtimal olunur ki") azaldın');
  } else {
    if (analysis.aiPhraseDensity > 15) recommendations.push('Remove AI-typical phrases like "furthermore," "it is important to note," "delve into"');
    if (analysis.burstiness < 40) recommendations.push('Vary sentence lengths — mix short punchy sentences with longer ones');
    if (analysis.perplexity < 55) recommendations.push('Use more varied vocabulary and unexpected word choices');
    if (analysis.sentenceStartDiversity < 60) recommendations.push('Start sentences differently — avoid always using "The," "This," or transition words');
    if (analysis.passiveVoiceRatio > 20) recommendations.push('Convert passive voice to active voice where possible');
    if (analysis.transitionFrequency > 12) recommendations.push('Reduce transition words (however, moreover, furthermore) — use them sparingly');
    if (analysis.hedgingFrequency > 20) recommendations.push('Reduce hedging language ("it could be argued," "it is possible that")');
  }
  if (topAiSentences.length > 0 && topAiSentences[0].score < 30) {
    recommendations.push(`Focus on rewriting the lowest-scoring sentence: "${topAiSentences[0].text}"`);
  }
  if (recommendations.length === 0) recommendations.push('Text reads naturally — no major AI patterns detected');

  return {
    overallScore: score,
    confidenceInterval,
    verdict: overallVerdict,
    topAiSentences,
    topHumanSentences,
    foundAiPhrases,
    metricsSummary,
    recommendations,
  };
}

// ==================== UTILITY FUNCTIONS ====================

export function getScoreColor(score: number): string {
  if (score >= 70) return 'text-green-400';
  if (score >= 50) return 'text-yellow-400';
  return 'text-red-400';
}

export function getClassificationColor(classification: 'human' | 'maybe' | 'ai'): string {
  switch (classification) {
    case 'human': return 'bg-green-500/20 border-green-500/50';
    case 'maybe': return 'bg-yellow-500/20 border-yellow-500/50';
    case 'ai': return 'bg-red-500/20 border-red-500/50';
  }
}

export function getScoreBarColor(score: number): string {
  if (score >= 70) return 'bg-green-500';
  if (score >= 50) return 'bg-yellow-500';
  return 'bg-red-500';
}
