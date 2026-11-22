/**
 * Internal Azerbaijani rewrite quality analyzer (silent, server-side).
 * Used behind the scenes in aggressive/ninja modes to detect leftover verbatim
 * n-gram overlap, repetitive paragraph/sentence openers, AI clichés, Turkish
 * calques, and heavy passive voice so Pass 2 can fix ONLY those exact weak spots.
 */

import { splitIntoSentences, toLowerLocale } from './text-utils';

const PLACEHOLDER_RE = /__PROTECT_\d+__/g;

const AZ_CLICHES = [
  'qeyd etmək vacibdir ki', 'qeyd etmək lazımdır ki', 'xüsusilə qeyd etmək lazımdır',
  'xüsusilə vurğulamaq lazımdır', 'nəzərə almaq lazımdır ki',
  'mühüm rol oynayır', 'əsas rol oynayır', 'həlledici rol oynayır',
  'mühüm əhəmiyyət kəsb edir', 'böyük əhəmiyyət kəsb edir', 'həlledici əhəmiyyət kəsb edir',
  'böyük əhəmiyyət daşıyır', 'mühüm əhəmiyyət daşıyır', 'xüsusi əhəmiyyətə malikdir',
  'əsas istiqamətlərindən biridir', 'ən mühüm üstünlüklərindən biri', 'digər mühüm üstünlük',
  'geniş tətbiq sahələri yaradır', 'aktual tədqiqat istiqamətlərindəndir',
  'nəticə etibarilə', 'nəticə olaraq', 'yekun olaraq', 'xülasə olaraq',
  'müasir dünyada', 'müasir dövrdə', 'rəqəmsal əsrdə', 'qloballaşan dünyada',
  'özündə ehtiva edir', 'böyük potensiala malikdir', 'müsbət təsir göstərir',
  'imkan verəcəkdir', 'bundan əlavə', 'bununla yanaşı',
];

const AZ_CALQUES = [
  'gerçəkləşdirmək', 'gerçəkləşdirilir', 'gerçəkləşdirir',
  'önəmli', 'özəllik', 'özəlliklər', 'özəllikləri',
  'sürəc', 'sürəci', 'sürəclər', 'düzəy', 'uyğulama', 'uyğulamalar',
  'gəlişmiş', 'dəyərləndirmək', 'örtüşən',
];

function cleanWords(text: string): string[] {
  return toLowerLocale(text.replace(PLACEHOLDER_RE, ' '), true)
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function buildNgrams(words: string[], n: number): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    set.add(words.slice(i, i + n).join(' '));
  }
  return set;
}

export interface AzPolishAudit {
  needsPolish: boolean;
  issues: string[];
  verbatimOverlapRatio: number;
  verbatimSamples: string[];
  repetitiveOpeners: string[];
  passiveRatio: number;
}

export function findAzerbaijaniRewriteIssues(original: string, candidate: string): AzPolishAudit {
  const issues: string[] = [];
  const origWords = cleanWords(original);
  const candWords = cleanWords(candidate);

  // 1. Verbatim 5-gram overlap check (catches copied clause chains)
  let verbatimOverlapRatio = 0;
  const verbatimSamples: string[] = [];
  if (origWords.length >= 12 && candWords.length >= 12) {
    const orig5 = buildNgrams(origWords, 5);
    const cand5 = buildNgrams(candWords, 5);
    let hits = 0;
    for (const gram of cand5) {
      if (orig5.has(gram)) {
        hits++;
        if (verbatimSamples.length < 5) verbatimSamples.push(gram);
      }
    }
    verbatimOverlapRatio = cand5.size > 0 ? hits / cand5.size : 0;
    if (verbatimOverlapRatio > 0.12 || verbatimSamples.length >= 3) {
      issues.push(
        `Orijinal mətndən sözbəsöz qalan ifadələri tamamilə yeni cümlə quruluşu ilə əvəzlə: "${verbatimSamples.slice(0, 3).join('", "')}"`
      );
    }
  }

  // 2. Remaining AI clichés and Turkish calques
  const candLower = toLowerLocale(candidate.replace(PLACEHOLDER_RE, ' '), true);
  const foundCliches = AZ_CLICHES.filter(p => candLower.includes(p));
  if (foundCliches.length > 0) {
    issues.push(`Bu AI şablon ifadələrini çıxar və təbii ifadə ilə əvəzlə: "${foundCliches.slice(0, 4).join('", "')}"`);
  }

  const foundCalques = AZ_CALQUES.filter(c =>
    new RegExp(`(?<![\\p{L}\\p{N}])${c}(?![\\p{L}\\p{N}])`, 'iu').test(candLower)
  );
  if (foundCalques.length > 0) {
    issues.push(`Türkiyə türkcəsi təsirini Azərbaycan ədəbi qarşılığı ilə dəyiş: "${foundCalques.slice(0, 4).join('", "')}"`);
  }

  // 3. Repetitive 2-word sentence openers (e.g. starting 3+ sentences with "FIR süzgəcləri")
  const sentences = splitIntoSentences(candidate.replace(PLACEHOLDER_RE, ' '));
  const openerCounts = new Map<string, { count: number; display: string }>();
  for (const s of sentences) {
    const rawWs = s.match(/[\p{L}\p{N}]+/gu) ?? [];
    const normWs = cleanWords(s);
    if (normWs.length >= 2 && rawWs.length >= 2) {
      const key = `${normWs[0]} ${normWs[1]}`;
      const existing = openerCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        openerCounts.set(key, { count: 1, display: `${rawWs[0]} ${rawWs[1]}` });
      }
    }
  }
  const repetitiveOpeners = [...openerCounts.values()]
    .filter((entry) => entry.count >= 3)
    .sort((a, b) => b.count - a.count)
    .map((entry) => entry.display);
  if (repetitiveOpeners.length > 0) {
    issues.push(`Eyni başlanğıcla təkrarlanan cümlələrin girişini müxtəlifləşdir: "${repetitiveOpeners.slice(0, 3).join('", "')}"`);
  }

  // 4. Excessive passive voice ratio (> 32%)
  const azPassiveRe = /(?<!\p{L})\p{L}+(?:ıl|il|ul|ül|ın|in|un|ün)(?:dı|di|du|dü|mış|miş|muş|müş|ır|ir|ur|ür|acaq|əcək|maqdadır|məkdədir)(?!\p{L})/giu;
  let passiveHits = 0;
  for (const s of sentences) {
    const m = s.match(azPassiveRe);
    if (m) passiveHits += m.length;
  }
  const passiveRatio = sentences.length >= 3 ? passiveHits / sentences.length : 0;
  if (passiveRatio > 0.35) {
    issues.push('Məchul növ fellərin ("istifadə olunur", "tətbiq edilir", "təmin edilir") sayını azaldıb icraçı aydın olan yerlərdə fəal fellər işlət.');
  }

  return {
    needsPolish: issues.length > 0,
    issues,
    verbatimOverlapRatio: Math.round(verbatimOverlapRatio * 100) / 100,
    verbatimSamples,
    repetitiveOpeners,
    passiveRatio: Math.round(passiveRatio * 100) / 100,
  };
}
