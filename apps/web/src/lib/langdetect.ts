/**
 * Lightweight, AI-free language detection for French, English and Spanish,
 * based on weighted stop-word fingerprints. Returns 'other' for confidently
 * non-supported text, null when there is not enough text to judge.
 *
 * Used only to decide whether to offer the "Translate" button — the actual
 * source language reported to the user comes from the AI translation itself.
 */

export type DetectedLang = 'fr' | 'en' | 'es' | 'other' | null

/** [word, weight] — distinctive function words and common email formulas. */
const FINGERPRINTS: Record<'fr' | 'en' | 'es', [string, number][]> = {
  fr: [
    ['le', 3], ['la', 3], ['les', 3], ['des', 3], ['une', 2], ['est', 3], ['vous', 3], ['nous', 2],
    ['votre', 3], ['pour', 2], ['dans', 3], ['avec', 2], ['cette', 2], ['aux', 2], ['très', 2],
    ['être', 2], ['merci', 3], ['bonjour', 3], ['cordialement', 4], ['madame', 3], ['monsieur', 3],
    ['cher', 2], ['chére', 2], ['bien', 1], ['afin', 3], ['ainsi', 2], ['puisqu', 2], ['qu\'il', 2],
    ['d\'un', 2], ['d\'une', 2], ['n\'est', 2], ['je', 2], ['ne', 1], ['ce', 1], ['sur', 1], ['plus', 1],
  ],
  en: [
    ['the', 3], ['is', 3], ['are', 3], ['you', 3], ['your', 3], ['please', 3], ['thanks', 3],
    ['thank', 2], ['regards', 3], ['regarding', 3], ['dear', 2], ['hello', 2], ['attached', 3],
    ['will', 2], ['with', 2], ['from', 1], ['this', 2], ['that', 2], ['have', 2], ['has', 2],
    ['not', 1], ['and', 1], ['for', 1], ['would', 2], ['could', 2], ['we', 2], ['our', 2],
  ],
  es: [
    ['el', 3], ['los', 3], ['las', 3], ['para', 3], ['con', 2], ['por', 2], ['usted', 3],
    ['gracias', 3], ['hola', 3], ['estimado', 3], ['señor', 3], ['señora', 3], ['saludos', 3],
    ['más', 2], ['está', 2], ['estimada', 3], ['su', 1], ['sus', 2], ['pero', 2], ['como', 2],
    ['muy', 2], ['este', 2], ['esta', 2], ['le', 1], ['un', 1], ['una', 2], ['que', 1], ['de', 1],
  ],
}

// Words that look alike in two languages must not double-count: drop the
// ambiguous low-weight entries when the same token exists in another list.
const AMBIGUOUS = new Set(['de', 'que', 'un', 'le', 'su', 'ne', 'ce', 'sur', 'plus', 'from', 'and', 'for', 'not'])

const MIN_WORDS = 8
/** Minimum normalized score (points per 100 words) to declare a language. */
const THRESHOLD = 4

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&#\d+;/g, ' ')
}

function tokenize(text: string): string[] {
  return (text ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .match(/[\p{L}']+/gu) ?? []
}

export function detectLanguage(input: string | null | undefined): DetectedLang {
  const words = tokenize(input ?? '')
  if (words.length < MIN_WORDS) return null
  const scores: Record<'fr' | 'en' | 'es', number> = { fr: 0, en: 0, es: 0 }
  for (const w of words) {
    for (const lang of ['fr', 'en', 'es'] as const) {
      for (const [word, weight] of FINGERPRINTS[lang]) {
        if (w === word && !(AMBIGUOUS.has(word) && weight <= 1)) scores[lang] += weight
      }
    }
  }
  // Normalize per 100 words so short notes and long newsletters compare fairly.
  const per100 = (n: number) => (n * 100) / words.length
  const entries = (Object.entries(scores) as ['fr' | 'en' | 'es', number][]).map(([lang, s]) => [lang, per100(s)] as const)
  entries.sort((a, b) => b[1] - a[1])
  const [best, bestScore] = entries[0]!
  const secondScore = entries[1]![1]
  if (bestScore < THRESHOLD) return 'other'
  if (bestScore < secondScore * 1.4) return 'other' // too ambiguous between the three
  return best
}
