import { ref } from 'vue'

/**
 * Light / dark / auto theme. `auto` follows the OS `prefers-color-scheme` and
 * tracks it live. The explicit choice is remembered in localStorage; there is
 * no server-side copy — appearance is a per-device preference by nature.
 *
 * applyTheme() runs at module load (imported first in main.ts) so the correct
 * palette is on <html> before the first paint — no flash of light theme.
 */

export type ThemeChoice = 'auto' | 'light' | 'dark'

const STORAGE_KEY = 'hermodmail.theme'
const CHOICES: ThemeChoice[] = ['auto', 'light', 'dark']

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return CHOICES.includes(v as ThemeChoice) ? (v as ThemeChoice) : 'auto'
  } catch {
    return 'auto'
  }
}

function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

function apply(choice: ThemeChoice): void {
  const dark = choice === 'dark' || (choice === 'auto' && systemPrefersDark())
  document.documentElement.classList.toggle('dark', dark)
  // Paint native widgets (scrollbars, form controls) accordingly too.
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}

/** Reactive theme choice ('auto' by default). */
export const theme = ref<ThemeChoice>(stored())

apply(theme.value)

// 'auto' must track OS changes live.
if (typeof matchMedia === 'function') {
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (theme.value === 'auto') apply('auto')
    })
  } catch {
    /* older browsers: theme stays as computed at load */
  }
}

export function setTheme(choice: ThemeChoice): void {
  theme.value = choice
  try {
    localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    /* ignore */
  }
  apply(choice)
}
