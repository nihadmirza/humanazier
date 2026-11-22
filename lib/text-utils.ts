/**
 * Shared text utility functions for StealthHumanizer.
 * Consolidates sentence splitting, word counting, and sentence alignment
 * that were previously duplicated across 5+ files with inconsistent behavior.
 */

/**
 * Common abbreviations that should not trigger sentence breaks.
 */
const ABBREVIATIONS = new Set([
  'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr', 'St', 'etc', 'vs', 'i.e', 'e.g',
  'Inc', 'Ltd', 'Co', 'Corp', 'Rev', 'Gen', 'Sen', 'Rep', 'Pres', 'Hon', 'al',
  // Azerbaijani abbreviations
  'prof', 'dos', 'akad', 'm', 'sm', 'km', 'q', 'kq', 'ha', 'il', 'əsr', 'əs',
  'b.e', 'e.ə', 's', 'səh', 'şək', 'tab', 'bax', 'məs', 'tərc', 'nəşr',
]);

// Single-letter abbreviations (like "m.", "q.", "s." in "və s.") only stay inline
// when NOT followed by whitespace + an uppercase sentence start.
const SINGLE_LETTER_ABBRS = new Set(['m', 'q', 's']);

/**
 * Locale-safe lowercase helper.
 * Standard JS `toLowerCase()` turns Azerbaijani 'İ' into 'i\u0307' (two code
 * points) and 'I' into 'i' instead of 'ı', breaking phrase/keyword matching.
 */
export function toLowerLocale(text: string, isAz: boolean): string {
  return isAz ? text.toLocaleLowerCase('az-AZ') : text.toLowerCase();
}

/**
 * Detect if text is written in Azerbaijani.
 * Uses distinctive characters (especially 'ə'/'Ə' which is uniquely characteristic of Azerbaijani in Latin script)
 * as well as common Azerbaijani stop-words.
 */
export function isAzerbaijaniText(text: string): boolean {
  if (!text || text.length < 5) return false;
  // Strongest signal: Azerbaijani 'ə' or 'Ə' (unique in standard Latin orthographies)
  if (/[əƏ]/.test(text)) return true;

  // Characters used in Azerbaijani: ç, ş, ğ, ö, ü, ı, İ
  const azCharCount = (text.match(/[çşğöüıÇŞĞÖÜİ]/g) || []).length;

  // Unicode-safe boundary matching (\b and \w are ASCII-only in JS and fail on ç, ş, ğ, ö, ü, ı, İ)
  const lower = text.toLocaleLowerCase('az-AZ');
  const azWordPattern = /(?<![\p{L}\p{N}])(və|ilə|üçün|kimi|olan|etmək|ancaq|lakin|amma|buna|belə|çox|daha|həmçinin|olaraq|haqqında|baxmayaraq|olduğunu|edir|edirlər|olur|müasir|dünyada|rol|oynayır|qeyd|lazımdır|vacibdir|böyük|yeni|hər|öz|bütün|nəticə|insan|birlikdə|təmin|bu|bir|deyil|yoxdur|olacaq|üçün|dövr|inkişaf|təhsil|iş|gün|xalq)(?![\p{L}\p{N}])/gu;
  const azWordMatches = (lower.match(azWordPattern) || []).length;

  // Azerbaijani morphological suffixes: -dır/-dir/-dur/-dür, -maq/-mək, -yır/-yir/-yur/-yür, -acaq/-əcək
  const azSuffixMatches = (lower.match(/(?<![\p{L}\p{N}])\p{L}{2,}(?:dır|dir|dur|dür|maq|mək|yır|yir|yur|yür|mışdır|mişdir|muşdur|müşdür|acaq|əcək)(?![\p{L}\p{N}])/gu) || []).length;

  if (azWordMatches >= 2 || (azCharCount >= 1 && azWordMatches >= 1) || (azCharCount >= 2 && azSuffixMatches >= 1) || azSuffixMatches >= 2) {
    return true;
  }
  return false;
}

function endsWithAbbreviation(text: string, periodIndex: number): boolean {
  const windowStart = Math.max(0, periodIndex - 12);
  const beforePeriod = text.slice(windowStart, periodIndex);
  // Extract the whole token immediately preceding the period (must be preceded by
  // start-of-string or a non-letter/non-digit boundary so "yazdım." does NOT match "m.").
  const tokenMatch = beforePeriod.match(/(?:^|[^\p{L}\p{N}.])([\p{L}.]+)$/u);
  if (!tokenMatch) return false;
  const token = tokenMatch[1];
  if (!ABBREVIATIONS.has(token) && !ABBREVIATIONS.has(token.toLocaleLowerCase('az-AZ'))) {
    return false;
  }
  const lowerToken = token.toLocaleLowerCase('az-AZ');
  if (SINGLE_LETTER_ABBRS.has(lowerToken)) {
    // Allow sentence break after "və s." when followed by whitespace + uppercase letter
    const after = text.slice(periodIndex + 1, periodIndex + 10);
    if (/^\s+\p{Lu}/u.test(after)) return false;
  }
  return true;
}

/**
 * Split text into sentences with abbreviation and identifier handling.
 * This is the unified version used across the entire application.
 *
 * Features:
 * - Handles abbreviations (Mr., Dr., məs., səh., etc.) without breaking words that merely end in the same letters
 * - Protects identifiers (file.ext, domain.tld, version 3.x, IP addresses)
 * - Handles trailing quotes after sentence endings
 */
export function splitIntoSentences(text: string): string[] {
  if (!text || !text.trim()) return [];

  const sentences: string[] = [];
  let current = '';
  let i = 0;

  while (i < text.length) {
    current += text[i];
    if (['.', '!', '?'].includes(text[i])) {
      // Period inside an identifier (file.ext, domain.tld, version 3.x, decimal 0.5,
      // IP 192.168.1.1) is not a sentence end. Detect by alnum-period-alnum with no
      // whitespace on either side.
      const isInsideIdentifier = text[i] === '.'
        && /[a-zA-Z0-9]/.test(text[i - 1] || '')
        && /[a-zA-Z0-9]/.test(text[i + 1] || '');
      const isAbbreviation = text[i] === '.' && endsWithAbbreviation(text, i);
      if (!isInsideIdentifier && !isAbbreviation) {
        if (text[i + 1] === '"' || text[i + 1] === "'") { current += text[i + 1]; i++; }
        const trimmed = current.trim();
        if (trimmed.length > 0) sentences.push(trimmed);
        current = '';
      }
    }
    i++;
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) sentences.push(trimmed);
  return sentences;
}

/**
 * Count words in text.
 * Handles both space-delimited and CJK text.
 */
export function countWords(text: string): number {
  if (!text || !text.trim()) return 0;
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

/**
 * Build sentence-level results by aligning original and humanized sentences.
 *
 * Rows where BOTH sides are empty are dropped, and a humanized cell that is a
 * bare interjection fragment ("Honestly?", "Right.", "But wait,") is folded
 * into the previous humanized cell rather than shown as its own line. This
 * keeps the side-by-side diff honest even when the humanized text has a few
 * more or fewer sentences than the original.
 */
export interface SentenceAlignment {
  original: string;
  humanized: string;
  index: number;
}

const FRAGMENT_INTERJECTION = /^\s*(honestly|right|exactly|yeah|hmm|look|so|plus|well|ok|okay|true story|funny enough|makes sense|but wait|and is that|sound familiar|who would have thought)[!,?.]?\s*$/i;

function isFragment(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (FRAGMENT_INTERJECTION.test(t)) return true;
  // Very short, no sentence-ending punctuation, and no verb-like token -> likely a fragment
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && !/[.!?]$/.test(t)) return true;
  return false;
}

export function buildSentenceResults(
  originalText: string,
  humanizedText: string
): SentenceAlignment[] {
  const origSentences = splitIntoSentences(originalText);
  const humanizedSentences = splitIntoSentences(humanizedText);

  // If counts are close (within 2), do standard alignment
  const results: SentenceAlignment[] = [];

  if (Math.abs(origSentences.length - humanizedSentences.length) <= 2) {
    const maxLen = Math.max(origSentences.length, humanizedSentences.length);
    for (let i = 0; i < maxLen; i++) {
      const original = origSentences[i] || '';
      const humanized = humanizedSentences[i] || '';

      // Skip fully-empty rows.
      if (!original.trim() && !humanized.trim()) continue;

      // If the humanized cell is a bare fragment, fold it into the previous row's
      // humanized text so it never appears as its own (misleading) line.
      if (original.trim() && isFragment(humanized) && results.length > 0) {
        const prev = results[results.length - 1];
        prev.humanized = `${prev.humanized} ${humanized}`.trim();
        continue;
      }

      results.push({ original, humanized, index: results.length });
    }
  } else {
    // Significant mismatch: pair up as many as possible, then merge remainders
    const minLen = Math.min(origSentences.length, humanizedSentences.length);
    for (let i = 0; i < minLen; i++) {
      const original = origSentences[i];
      const humanized = humanizedSentences[i];

      if (!original.trim() && !humanized.trim()) continue;

      if (original.trim() && isFragment(humanized) && results.length > 0) {
        const prev = results[results.length - 1];
        prev.humanized = `${prev.humanized} ${humanized}`.trim();
        continue;
      }

      results.push({ original, humanized, index: results.length });
    }

    // Merge excess originals into the last row's original
    if (origSentences.length > minLen && results.length > 0) {
      const excess = origSentences.slice(minLen).join(' ');
      results[results.length - 1].original += ' ' + excess;
    }

    // Merge excess humanized into the last row's humanized
    if (humanizedSentences.length > minLen && results.length > 0) {
      const excess = humanizedSentences.slice(minLen).join(' ');
      results[results.length - 1].humanized += ' ' + excess;
    }
  }

  return results;
}
