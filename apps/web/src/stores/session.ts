import { defineStore } from 'pinia'
import { api, type MailAccountInfo, type PublicUser, type FolderInfo, type AiSettings, type UserSettings } from '@/lib/api'
import { adoptServerLocale } from '@/lib/i18n'
import { ref } from 'vue'

export const useSessionStore = defineStore('session', () => {
  const user = ref<PublicUser | null>(null)
  const needsSetup = ref<boolean | null>(null)
  const loaded = ref(false)

  async function checkSetup(): Promise<boolean> {
    const res = await api.get<{ needsSetup: boolean }>('/api/setup/status')
    needsSetup.value = res.needsSetup
    return res.needsSetup
  }

  async function fetchMe(): Promise<PublicUser | null> {
    try {
      const res = await api.get<{ user: PublicUser }>('/api/auth/me')
      user.value = res.user
      return res.user
    } catch {
      user.value = null
      return null
    } finally {
      loaded.value = true
    }
  }

  async function login(email: string, password: string) {
    const res = await api.post<{ user: PublicUser }>('/api/auth/login', { email, password })
    user.value = res.user
    return res.user
  }

  async function logout() {
    await api.post('/api/auth/logout')
    user.value = null
  }

  return { user, needsSetup, loaded, checkSetup, fetchMe, login, logout }
})

export const useAccountsStore = defineStore('accounts', () => {
  const accounts = ref<MailAccountInfo[]>([])
  const activeId = ref<string | null>(null)
  const folders = ref<FolderInfo[]>([])
  const loadingFolders = ref(false)

  async function refresh(): Promise<MailAccountInfo[]> {
    const res = await api.get<{ accounts: MailAccountInfo[] }>('/api/accounts')
    accounts.value = res.accounts
    if (!activeId.value && accounts.value.length) activeId.value = accounts.value[0]!.id
    if (activeId.value && !accounts.value.some((a) => a.id === activeId.value)) {
      activeId.value = accounts.value[0]?.id ?? null
    }
    return accounts.value
  }

  async function loadFolders(refreshFromServer = false) {
    if (!activeId.value) { folders.value = []; return }
    loadingFolders.value = true
    try {
      const res = await api.get<{ folders: FolderInfo[] }>(`/api/accounts/${activeId.value}/folders${refreshFromServer ? '?refresh=true' : ''}`)
      folders.value = res.folders
    } finally {
      loadingFolders.value = false
    }
  }

  function $reset() {
    accounts.value = []
    activeId.value = null
    folders.value = []
  }

  return { accounts, activeId, folders, loadingFolders, refresh, loadFolders, $reset }
})

export const useSettingsStore = defineStore('settings', () => {
  const refreshIntervalMs = ref<number>(60_000)
  const loaded = ref(false)

  async function load(): Promise<number> {
    try {
      const res = await api.get<UserSettings>('/api/settings')
      refreshIntervalMs.value = res.refreshIntervalMs
      // An explicit language choice made on another device wins over the
      // local detection ('' = never chosen server-side).
      adoptServerLocale(res.locale)
    } finally {
      loaded.value = true
    }
    return refreshIntervalMs.value
  }

  async function setRefreshInterval(ms: number): Promise<void> {
    const res = await api.put<UserSettings>('/api/settings', { refreshIntervalMs: ms })
    refreshIntervalMs.value = res.refreshIntervalMs
  }

  return { refreshIntervalMs, loaded, load, setRefreshInterval }
})
