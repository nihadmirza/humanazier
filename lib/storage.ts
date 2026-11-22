import { ApiKeys, HistoryEntry } from './types';
// Note: HistoryEntry fields are optional at storage level for backwards compatibility

const KEYS = {
  API_KEYS: 'stealthhumanizer_api_keys',
  HISTORY: 'stealthhumanizer_history',
  THEME: 'stealthhumanizer_theme',
  VISITED: 'stealthhumanizer_visited',
  PREFERRED_MODEL: 'stealthhumanizer_preferred_model',
  MODEL_VARIANTS: 'stealthhumanizer_model_variants',
};

function encode(data: string): string {
  return btoa(unescape(encodeURIComponent(data)));
}

function decode(data: string): string {
  return decodeURIComponent(escape(atob(data)));
}

// API Keys
export function getApiKeys(): ApiKeys {
  if (typeof window === 'undefined') return {};
  try {
    const stored = localStorage.getItem(KEYS.API_KEYS);
    if (!stored) return {};
    // Support both legacy plain JSON and new encoded format
    try {
      return JSON.parse(decode(stored));
    } catch {
      return JSON.parse(stored);
    }
  } catch {
    return {};
  }
}

export function setApiKeys(keys: ApiKeys): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEYS.API_KEYS, encode(JSON.stringify(keys)));
}

export function clearApiKeys(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(KEYS.API_KEYS);
}

// Preferred model selection — persisted so a user who picks their own provider
// (e.g. Gemini) keeps it across reloads instead of silently falling back to the
// default free model while their key sits unused.
export function getPreferredModel(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(KEYS.PREFERRED_MODEL);
  } catch {
    return null;
  }
}

export function setPreferredModel(model: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(KEYS.PREFERRED_MODEL, model);
  } catch {}
}

// Per-provider model choice from Settings (e.g. { gemini: 'gemini-2.5-flash' }).
// The server only honours entries that are in the provider's model list.
export function getModelVariants(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(KEYS.MODEL_VARIANTS) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function setModelVariant(provider: string, model: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(KEYS.MODEL_VARIANTS, JSON.stringify({ ...getModelVariants(), [provider]: model }));
  } catch {}
}

// History
const MAX_HISTORY_ITEMS = 50;

export function getHistory(): HistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(KEYS.HISTORY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function addToHistory(entry: Partial<HistoryEntry> & { originalText: string; humanizedText: string }): HistoryEntry {
  const history = getHistory();
  const defaults: HistoryEntry = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    originalText: entry.originalText,
    humanizedText: entry.humanizedText,
    options: {
      style: 'academic',
      model: 'gemini',
      targetScore: 90,
      language: 'en',
    },
  };
  const newEntry = { ...defaults, ...entry, id: defaults.id, timestamp: defaults.timestamp };

  // Add to beginning, keep max items
  const updated = [newEntry, ...history].slice(0, MAX_HISTORY_ITEMS);

  if (typeof window !== 'undefined') {
    localStorage.setItem(KEYS.HISTORY, JSON.stringify(updated));
  }

  return newEntry;
}

export function deleteHistoryEntry(id: string): void {
  if (typeof window === 'undefined') return;
  const history = getHistory();
  const updated = history.filter(entry => entry.id !== id);
  localStorage.setItem(KEYS.HISTORY, JSON.stringify(updated));
}

export function clearHistory(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(KEYS.HISTORY);
}

// Theme
export function getSystemThemePreference(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function getTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  const stored = localStorage.getItem(KEYS.THEME);
  if (stored === 'system') return getSystemThemePreference();
  return (stored === 'light' || stored === 'dark') ? stored : getSystemThemePreference();
}

export function setTheme(theme: 'dark' | 'light' | 'system'): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEYS.THEME, theme);
}

export function onSystemThemeChange(callback: (theme: 'dark' | 'light') => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e: MediaQueryListEvent) => callback(e.matches ? 'dark' : 'light');
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}

// Visited flag
export function hasVisited(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(KEYS.VISITED) === 'true';
}

export function markVisited(): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(KEYS.VISITED, 'true');
}

// Word count utility
export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(word => word.length > 0).length;
}

// Text chunking for long texts (preserves paragraph breaks whenever possible)
export function chunkText(text: string, maxWords: number = 2500): string[] {
  if (countWords(text) <= maxWords) return [text];

  const paragraphs = text.split(/\n\s*\n/);
  const chunks: string[] = [];
  let currentParts: string[] = [];
  let currentWordCount = 0;

  const flush = () => {
    if (currentParts.length > 0) {
      chunks.push(currentParts.join('\n\n'));
      currentParts = [];
      currentWordCount = 0;
    }
  };

  for (const para of paragraphs) {
    const paraWords = countWords(para);
    if (paraWords === 0) continue;

    if (paraWords <= maxWords) {
      if (currentWordCount + paraWords > maxWords && currentParts.length > 0) {
        flush();
      }
      currentParts.push(para);
      currentWordCount += paraWords;
      continue;
    }

    // Single oversized paragraph: flush accumulated paragraphs, then split at sentence boundaries
    flush();
    const words = para.split(/\s+/);
    let sub: string[] = [];
    for (const word of words) {
      sub.push(word);
      if (sub.length >= maxWords) {
        const joined = sub.join(' ');
        const lastEnd = Math.max(joined.lastIndexOf('.'), joined.lastIndexOf('!'), joined.lastIndexOf('?'));
        if (lastEnd > joined.length * 0.5) {
          chunks.push(joined.slice(0, lastEnd + 1));
          const rem = joined.slice(lastEnd + 1).trim();
          sub = rem ? rem.split(/\s+/) : [];
        } else {
          chunks.push(joined);
          sub = [];
        }
      }
    }
    if (sub.length > 0) chunks.push(sub.join(' '));
  }

  flush();
  return chunks.length > 0 ? chunks : [text];
}

// Format date
export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Download utilities
export function downloadAsTxt(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadAsDocx(text: string, filename: string): void {
  // HTML-escape user content to prevent XSS
  function escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  const safeFilename = escapeHtml(filename);
  const safeText = escapeHtml(text);

  // Simple DOCX format (just wrapped text)
  const docContent = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office"
          xmlns:w="urn:schemas-microsoft-com:office:word"
          xmlns="http://www.w3.org/TR/REC-html40">
      <head>
        <meta charset="utf-8">
        <title>${safeFilename}</title>
      </head>
      <body>
        ${safeText.split('\n').map(p => `<p>${p}</p>`).join('\n')}
      </body>
    </html>
  `;

  const blob = new Blob([docContent], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.doc`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadAsMarkdown(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filename}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
