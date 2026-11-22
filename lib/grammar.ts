import { isAzerbaijaniText } from './text-utils';

export interface GrammarIssue {
  type: 'grammar' | 'spelling' | 'punctuation' | 'phrasing';
  original: string;
  suggestion: string;
  explanation: string;
}

export interface GrammarCheckResult {
  issues: GrammarIssue[];
  correctedText: string;
  source: 'llm' | 'local-fallback';
}

const AZ_LOCAL_RULES: Array<{
  type: GrammarIssue['type'];
  pattern: RegExp;
  replacement: string;
  explanation: string;
}> = [
  { type: 'phrasing', pattern: /(?<![\p{L}\p{N}])gerçəkləşdirmək(?![\p{L}\p{N}])/giu, replacement: 'həyata keçirmək', explanation: 'Türkiyə türkcəsi təsirini Azərbaycan ədəbi normasına uyğunlaşdırır.' },
  { type: 'phrasing', pattern: /(?<![\p{L}\p{N}])gerçəkləşdirilir(?![\p{L}\p{N}])/giu, replacement: 'həyata keçirilir', explanation: 'Türkiyə türkcəsi təsirini Azərbaycan ədəbi normasına uyğunlaşdırır.' },
  { type: 'phrasing', pattern: /(?<![\p{L}\p{N}])önəmli(?![\p{L}\p{N}])/giu, replacement: 'vacib', explanation: 'Azərbaycan ədəbi dilində daha təbii qarşılıq işlədir.' },
  { type: 'phrasing', pattern: /(?<![\p{L}\p{N}])özəllik(?![\p{L}\p{N}])/giu, replacement: 'xüsusiyyət', explanation: 'Türkiyə türkcəsi təsirini Azərbaycan ədəbi normasına uyğunlaşdırır.' },
  { type: 'phrasing', pattern: /(?<![\p{L}\p{N}])özəlliklər(?![\p{L}\p{N}])/giu, replacement: 'xüsusiyyətlər', explanation: 'Türkiyə türkcəsi təsirini Azərbaycan ədəbi normasına uyğunlaşdırır.' },
  { type: 'phrasing', pattern: /(?<![\p{L}\p{N}])sürəc(?![\p{L}\p{N}])/giu, replacement: 'proses', explanation: 'Türkiyə türkcəsi təsirini Azərbaycan ədəbi normasına uyğunlaşdırır.' },
  { type: 'phrasing', pattern: /(?<![\p{L}\p{N}])uyğulama(?![\p{L}\p{N}])/giu, replacement: 'tətbiq', explanation: 'Türkiyə türkcəsi təsirini Azərbaycan ədəbi normasına uyğunlaşdırır.' },
  { type: 'phrasing', pattern: /(?<![\p{L}\p{N}])düzəy(?![\p{L}\p{N}])/giu, replacement: 'səviyyə', explanation: 'Türkiyə türkcəsi təsirini Azərbaycan ədəbi normasına uyğunlaşdırır.' },
  { type: 'phrasing', pattern: /(?<![\p{L}\p{N}])gəlişmiş(?![\p{L}\p{N}])/giu, replacement: 'inkişaf etmiş', explanation: 'Türkiyə türkcəsi təsirini Azərbaycan ədəbi normasına uyğunlaşdırır.' },
  { type: 'phrasing', pattern: /(?<![\p{L}\p{N}])dəyərləndirmək(?![\p{L}\p{N}])/giu, replacement: 'qiymətləndirmək', explanation: 'Türkiyə türkcəsi təsirini Azərbaycan ədəbi normasına uyğunlaşdırır.' },
  { type: 'punctuation', pattern: /[ \t]+([,.;:!?])/g, replacement: '$1', explanation: 'Durğu işarəsindən əvvəlki artıq boşluğu silir.' },
  { type: 'punctuation', pattern: /([,.;:!?])(?!\d)([^\s\d”’"')\]}])/g, replacement: '$1 $2', explanation: 'Durğu işarəsindən sonra boşluq əlavə edir.' },
  { type: 'punctuation', pattern: /[ \t]{2,}/g, replacement: ' ', explanation: 'Təkrarlanan boşluqları birləşdirir.' },
];

const LOCAL_RULES: Array<{
  type: GrammarIssue['type'];
  pattern: RegExp;
  replacement: string | ((match: string, ...args: string[]) => string);
  explanation: string;
}> = [
  { type: 'spelling', pattern: /\bgrammer\b/gi, replacement: 'grammar', explanation: 'Corrects a common spelling mistake.' },
  { type: 'spelling', pattern: /\bbeofre\b/gi, replacement: 'before', explanation: 'Corrects a common spelling mistake.' },
  { type: 'spelling', pattern: /\beveryhting\b/gi, replacement: 'everything', explanation: 'Corrects a common spelling mistake.' },
  { type: 'grammar', pattern: /\bi\b/g, replacement: 'I', explanation: 'Capitalizes the first-person pronoun.' },
  { type: 'grammar', pattern: /\b([Tt])here is (\w+) (?:that|who|which) are\b/g, replacement: '$1here are $2 that are', explanation: 'Fixes subject-verb agreement.' },
  { type: 'grammar', pattern: /\b([Tt])here are (\w+) (?:that|who|which) is\b/g, replacement: '$1here is $2 that is', explanation: 'Fixes subject-verb agreement.' },
  { type: 'grammar', pattern: /\b([Hh]e|[Ss]he|[Ii]t) are\b/g, replacement: '$1 is', explanation: 'Uses the singular verb form with a singular subject.' },
  { type: 'grammar', pattern: /\b([Tt]hey|[Ww]e|[Yy]ou) is\b/g, replacement: '$1 are', explanation: 'Uses the plural verb form with a plural subject.' },
  { type: 'grammar', pattern: /\bdoes not has\b/gi, replacement: 'does not have', explanation: 'Uses the base verb after “does”.' },
  { type: 'grammar', pattern: /\bdid not (\w+)ed\b/gi, replacement: 'did not $1', explanation: 'Uses the base verb after “did”.' },
  { type: 'phrasing', pattern: /\bin order to\b/gi, replacement: 'to', explanation: 'Removes wordy phrasing.' },
  { type: 'phrasing', pattern: /\bdue to the fact that\b/gi, replacement: 'because', explanation: 'Replaces wordy phrasing with a clearer word.' },
  { type: 'punctuation', pattern: /\s+([,.;:!?])/g, replacement: '$1', explanation: 'Removes spaces before punctuation.' },
  // Skips digit,punct,digit so thousands separators like "147,570" are never "corrected".
  { type: 'punctuation', pattern: /([,.;:!?])(?!\d)([^\s\d”’"')\]}])/g, replacement: '$1 $2', explanation: 'Adds a missing space after punctuation.' },
  { type: 'punctuation', pattern: /\s{2,}/g, replacement: ' ', explanation: 'Collapses repeated spaces.' },
];

function preserveCase(original: string, replacement: string, isAz = false): string {
  const upper = isAz ? original.toLocaleUpperCase('az-AZ') : original.toUpperCase();
  if (upper === original) return isAz ? replacement.toLocaleUpperCase('az-AZ') : replacement.toUpperCase();
  const firstUpper = isAz ? original[0]?.toLocaleUpperCase('az-AZ') : original[0]?.toUpperCase();
  if (firstUpper === original[0]) {
    const repFirst = isAz ? replacement[0].toLocaleUpperCase('az-AZ') : replacement[0].toUpperCase();
    return repFirst + replacement.slice(1);
  }
  return replacement;
}

function addIssue(issues: GrammarIssue[], type: GrammarIssue['type'], original: string, suggestion: string, explanation: string) {
  if (!original || original === suggestion) return;
  if (issues.some(issue => issue.original === original && issue.suggestion === suggestion)) return;
  issues.push({ type, original, suggestion, explanation });
}

function capitalizeSentenceStarts(text: string, issues: GrammarIssue[], isAz = false): string {
  if (isAz) {
    return text.replace(/(^|[.!?]\s+)([\p{Ll}])/gu, (match, prefix: string, letter: string, offset: number) => {
      const before = text.slice(0, offset + prefix.length).trimEnd();
      if (/^[.!?]/.test(prefix) && /(?:^|\s)(?:məs|səh|prof|dos|və\s+s)\.$/iu.test(before)) return match;
      const suggestion = `${prefix}${letter.toLocaleUpperCase('az-AZ')}`;
      addIssue(issues, 'punctuation', match, suggestion, 'Cümlənin ilk hərfini böyük yazır.');
      return suggestion;
    });
  }
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (match, prefix: string, letter: string) => {
    const suggestion = `${prefix}${letter.toUpperCase()}`;
    addIssue(issues, 'punctuation', match, suggestion, 'Capitalizes the first letter of a sentence.');
    return suggestion;
  });
}

function ensureTerminalPunctuation(text: string, issues: GrammarIssue[], isAz = false): string {
  const trimmed = text.trimEnd();
  if (!trimmed || /[.!?]$/.test(trimmed)) return text;
  addIssue(
    issues,
    'punctuation',
    trimmed.slice(-30),
    `${trimmed.slice(-30)}.`,
    isAz ? 'Cümlə sonuna əskik nöqtə əlavə edir.' : 'Adds missing terminal punctuation.'
  );
  return `${trimmed}.`;
}

export function checkGrammarLocally(text: string): GrammarCheckResult {
  const isAz = isAzerbaijaniText(text);
  const issues: GrammarIssue[] = [];
  let correctedText = text;
  const rules = isAz ? AZ_LOCAL_RULES : LOCAL_RULES;

  for (const rule of rules) {
    correctedText = correctedText.replace(rule.pattern, (...args: string[]) => {
      const match = args[0];
      const raw = typeof rule.replacement === 'function'
        ? rule.replacement(match, ...args.slice(1, -2))
        : match.replace(rule.pattern, rule.replacement);
      const suggestion = typeof rule.replacement === 'string' && /^[\p{L}\s]+$/u.test(rule.replacement)
        ? preserveCase(match, raw, isAz)
        : raw;
      addIssue(issues, rule.type, match, suggestion, rule.explanation);
      return suggestion;
    });
  }

  correctedText = capitalizeSentenceStarts(correctedText, issues, isAz);
  correctedText = ensureTerminalPunctuation(correctedText, issues, isAz);

  return { issues: issues.slice(0, 50), correctedText, source: 'local-fallback' };
}

export function normalizeGrammarPayload(value: unknown, fallbackText: string, source: GrammarCheckResult['source'] = 'llm'): GrammarCheckResult | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  const rawIssues = Array.isArray(payload.issues) ? payload.issues : [];
  const issues = rawIssues
    .filter((issue): issue is Record<string, unknown> => Boolean(issue) && typeof issue === 'object')
    .map(issue => ({
      type: ['grammar', 'spelling', 'punctuation', 'phrasing'].includes(String(issue.type)) ? issue.type as GrammarIssue['type'] : 'grammar',
      original: String(issue.original || ''),
      suggestion: String(issue.suggestion || ''),
      explanation: String(issue.explanation || 'Suggested correction.'),
    }))
    .filter(issue => issue.original && issue.suggestion);

  return {
    issues,
    correctedText: typeof payload.correctedText === 'string' && payload.correctedText.trim() ? payload.correctedText : fallbackText,
    source,
  };
}

export function parseFirstJsonObject(raw: string): unknown | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || raw;
  const start = candidate.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < candidate.length; i++) {
    const char = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    if (char === '}') depth--;
    if (depth === 0) {
      try {
        return JSON.parse(candidate.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}
