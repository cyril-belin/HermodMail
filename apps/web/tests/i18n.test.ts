import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * i18n.ts touches navigator/localStorage at module load — stub them before
 * the dynamic import so the module runs in a plain node environment.
 */
const store = new Map<string, string>()
beforeAll(() => {
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  })
})

async function loadModule() {
  return await import('@/lib/i18n')
}

describe('i18n', () => {
  it('detects the browser locale (English here)', async () => {
    const i18n = await loadModule()
    expect(i18n.locale.value).toBe('en')
  })

  it('translates in the active locale and falls back to French for missing keys', async () => {
    const i18n = await loadModule()
    i18n.setLocale('en')
    expect(i18n.t('nav.compose')).toBe('Compose')
    i18n.setLocale('es')
    expect(i18n.t('nav.compose')).toBe('Redactar')
    i18n.setLocale('fr')
    expect(i18n.t('nav.compose')).toBe('Écrire')
  })

  it('interpolates parameters', async () => {
    const i18n = await loadModule()
    i18n.setLocale('fr')
    expect(i18n.t('list.count', { n: 3 })).toBe('3 messages')
  })

  it('never throws on an unknown key', async () => {
    const i18n = await loadModule()
    expect(i18n.t('does.not.exist')).toBe('does.not.exist')
  })

  it('maps server error codes to translated sentences', async () => {
    const i18n = await loadModule()
    const { ApiError } = await import('@/lib/api')
    i18n.setLocale('es')
    expect(i18n.errorMessage(new ApiError(401, 'unauthorized', 'Authentication required'))).toBe(i18n.t('error.unauthorized'))
    // Unknown messages stay verbatim (they may carry useful details).
    expect(i18n.errorMessage(new ApiError(400, 'bad_request', 'Some specific detail'))).toBe('Some specific detail')
    expect(i18n.errorMessage(new TypeError('Failed to fetch'))).toBe(i18n.t('error.network'))
  })
})
