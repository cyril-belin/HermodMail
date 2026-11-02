<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import {
  ArrowLeft, Plus, Trash2, PlugZap, KeyRound, Users as UsersIcon, Bot, Mail as MailIcon, Copy, Check, Pencil, RefreshCw,
  Eye, EyeOff, X, ShieldCheck, BookUser, Languages,
} from 'lucide-vue-next'
import { api, type MailAccountInfo, type ApiTokenInfo, type PublicUser, type AiSettings, type ContactInfo, REFRESH_INTERVAL_VALUES } from '@/lib/api'
import { useSessionStore, useSettingsStore } from '@/stores/session'
import { t, errorMessage, locale, setLocale, LOCALES, LOCALE_NAMES } from '@/lib/i18n'
import { theme, setTheme, type ThemeChoice } from '@/lib/theme'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Label from '@/components/ui/Label.vue'
import Badge from '@/components/ui/Badge.vue'
import Card from '@/components/ui/Card.vue'
import Dialog from '@/components/ui/Dialog.vue'
import Select from '@/components/ui/Select.vue'
import Switch from '@/components/ui/Switch.vue'
import Spinner from '@/components/ui/Spinner.vue'
import { ALL_SCOPES } from '@/lib/scopes'

const session = useSessionStore()
const router = useRouter()
const tab = ref<'accounts' | 'tokens' | 'contacts' | 'users' | 'ai'>('accounts')
const error = ref('')

// ----- interface language --------------------------------------------------------
const languageOptions = computed(() => LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] })))

function onLanguageChange(event: Event) {
  setLocale((event.target as HTMLSelectElement).value as typeof locale.value)
}

// ----- theme ---------------------------------------------------------------------
const themeOptions = computed(() => [
  { value: 'auto', label: t('settings.theme_auto') },
  { value: 'light', label: t('settings.theme_light') },
  { value: 'dark', label: t('settings.theme_dark') },
])

function onThemeChange(event: Event) {
  setTheme((event.target as HTMLSelectElement).value as ThemeChoice)
}

// ----- accounts ------------------------------------------------------------------
const settingsStore = useSettingsStore()
const accounts = ref<MailAccountInfo[]>([])
const showAccountDialog = ref(false)
const editingId = ref<string | null>(null)
const savingAccount = ref(false)
const testing = ref<string | null>(null)
const testResult = ref<string | null>(null)
const form = ref(emptyAccountForm())

function emptyAccountForm() {
  return {
    name: '', email: '',
    imapHost: '', imapPort: '993', imapTls: 'tls', imapUser: '', imapPassword: '',
    smtpHost: '', smtpPort: '587', smtpTls: 'starttls', smtpUser: '', smtpPassword: '',
  }
}

async function loadAccounts() {
  const res = await api.get<{ accounts: MailAccountInfo[] }>('/api/accounts')
  accounts.value = res.accounts
}

function openAddAccount() {
  editingId.value = null
  form.value = emptyAccountForm()
  showAccountDialog.value = true
}

function openEditAccount(a: MailAccountInfo) {
  editingId.value = a.id
  form.value = {
    name: a.name,
    email: a.email,
    imapHost: a.imap.host,
    imapPort: String(a.imap.port),
    imapTls: a.imap.tls,
    imapUser: a.imap.user,
    imapPassword: '', // blank = unchanged
    smtpHost: a.smtp.host,
    smtpPort: String(a.smtp.port),
    smtpTls: a.smtp.tls,
    smtpUser: a.smtp.user,
    smtpPassword: '', // blank = unchanged
  }
  showAccountDialog.value = true
}

async function saveAccount() {
  error.value = ''
  savingAccount.value = true
  try {
    const f = form.value
    if (editingId.value) {
      // Blank passwords mean "keep the stored secret" — they are never sent.
      await api.patch(`/api/accounts/${editingId.value}`, {
        name: f.name,
        email: f.email,
        imap: { host: f.imapHost, port: Number(f.imapPort), tls: f.imapTls, user: f.imapUser, ...(f.imapPassword ? { password: f.imapPassword } : {}) },
        smtp: { host: f.smtpHost, port: Number(f.smtpPort), tls: f.smtpTls, user: f.smtpUser || f.imapUser, ...(f.smtpPassword ? { password: f.smtpPassword } : {}) },
      })
    } else {
      await api.post('/api/accounts', {
        name: f.name, email: f.email,
        imap: { host: f.imapHost, port: Number(f.imapPort), tls: f.imapTls, user: f.imapUser, password: f.imapPassword },
        smtp: { host: f.smtpHost, port: Number(f.smtpPort), tls: f.smtpTls, user: f.smtpUser || f.imapUser, password: f.smtpPassword || f.imapPassword },
      })
    }
    showAccountDialog.value = false
    form.value = emptyAccountForm()
    editingId.value = null
    await loadAccounts()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    savingAccount.value = false
  }
}

async function testAccount(id: string) {
  testing.value = id
  testResult.value = null
  try {
    const res = await api.post<{ ok: boolean; folders: number }>(`/api/accounts/${id}/test`)
    testResult.value = t('settings.test_ok', { n: res.folders })
  } catch (err) {
    testResult.value = errorMessage(err)
  } finally {
    testing.value = null
  }
}

async function deleteAccount(id: string) {
  if (!confirm(t('settings.delete_account_confirm'))) return
  await api.delete(`/api/accounts/${id}`)
  await loadAccounts()
}

// ----- tokens --------------------------------------------------------------------
const tokens = ref<ApiTokenInfo[]>([])
const newTokenName = ref('')
const newTokenScopes = ref<string[]>(['mail:read'])
const createdToken = ref<string | null>(null)
const revealToken = ref(false)
const copied = ref(false)
const copyError = ref('')

// Only the hash is stored server-side: the full value exists here once, at
// creation time, and can never be re-fetched — hence masked by default.
const maskedToken = computed(() => {
  const t2 = createdToken.value
  if (!t2) return ''
  return `${t2.slice(0, 8)}${'•'.repeat(16)}${t2.slice(-4)}`
})

async function loadTokens() {
  const res = await api.get<{ tokens: ApiTokenInfo[] }>('/api/tokens')
  tokens.value = res.tokens
}

async function createToken() {
  error.value = ''
  try {
    const res = await api.post<{ info: ApiTokenInfo; token: string }>('/api/tokens', { name: newTokenName.value, scopes: newTokenScopes.value })
    createdToken.value = res.token
    revealToken.value = false
    copied.value = false
    copyError.value = ''
    newTokenName.value = ''
    await loadTokens()
  } catch (err) {
    error.value = errorMessage(err)
  }
}

async function revokeToken(id: string) {
  if (!confirm(t('settings.revoke_confirm'))) return
  await api.delete(`/api/tokens/${id}`)
  await loadTokens()
}

/** execCommand fallback for insecure contexts (plain HTTP, e.g. over Tailscale). */
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/** The confirmation only appears after a copy that actually succeeded. */
async function copyToken() {
  if (!createdToken.value) return
  const value = createdToken.value
  let ok = false
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      ok = true
    } catch {
      ok = false
    }
  }
  if (!ok) ok = legacyCopy(value)
  if (ok) {
    copyError.value = ''
    copied.value = true
    // The secret served its purpose: hide it again right away so the user
    // never has to dismiss the banner to stop looking at it.
    revealToken.value = false
    setTimeout(() => (copied.value = false), 1500)
  } else {
    copyError.value = t('settings.copy_failed')
  }
}

// ----- token permissions ----------------------------------------------------------
const editToken = ref<ApiTokenInfo | null>(null)
const editScopes = ref<string[]>([])
const savingScopes = ref(false)

function openEditScopes(t2: ApiTokenInfo) {
  editToken.value = t2
  editScopes.value = [...t2.scopes]
}

const editTokenDialogOpen = computed({
  get: () => editToken.value !== null,
  set: (open: boolean) => { if (!open) editToken.value = null },
})

async function saveScopes() {
  const token = editToken.value
  if (!token) return
  // Granting new privileges deserves an explicit confirmation; revoking some
  // does not (it only narrows what the agent can do).
  const added = editScopes.value.filter((s) => !token.scopes.includes(s))
  if (added.length && !confirm(t('settings.new_privileges_confirm', { scopes: added.join(', ') }))) return
  savingScopes.value = true
  error.value = ''
  try {
    const res = await api.put<{ token: ApiTokenInfo }>(`/api/tokens/${token.id}/scopes`, { scopes: editScopes.value })
    const idx = tokens.value.findIndex((t2) => t2.id === token.id)
    if (idx >= 0) tokens.value[idx] = res.token
    editToken.value = null
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    savingScopes.value = false
  }
}

// ----- users (admin) ----------------------------------------------------------------
const users = ref<PublicUser[]>([])
const newUser = ref({ email: '', password: '', displayName: '', isAdmin: false })

async function loadUsers() {
  if (!session.user?.isAdmin) return
  const res = await api.get<{ users: PublicUser[] }>('/api/users')
  users.value = res.users
}

async function addUser() {
  error.value = ''
  try {
    await api.post('/api/users', { email: newUser.value.email, password: newUser.value.password, displayName: newUser.value.displayName || undefined, isAdmin: newUser.value.isAdmin })
    newUser.value = { email: '', password: '', displayName: '', isAdmin: false }
    await loadUsers()
  } catch (err) {
    error.value = errorMessage(err)
  }
}

async function deleteUser(id: string) {
  if (!confirm(t('settings.delete_user_confirm'))) return
  await api.delete(`/api/users/${id}`)
  await loadUsers()
}

// ----- AI (admin) --------------------------------------------------------------------
const ai = ref<AiSettings>({ provider: 'none', baseUrl: '', model: '', systemHint: '' })
const aiApiKey = ref('')
const aiTesting = ref(false)
const aiTestResult = ref<string | null>(null)

async function loadAi() {
  if (!session.user?.isAdmin) return
  const res = await api.get<{ settings: AiSettings }>('/api/ai/settings')
  ai.value = res.settings
}

async function saveAi() {
  error.value = ''
  try {
    const res = await api.put<{ settings: AiSettings }>('/api/ai/settings', {
      provider: ai.value.provider, baseUrl: ai.value.baseUrl, model: ai.value.model,
      apiKey: aiApiKey.value || undefined, systemHint: ai.value.systemHint,
    })
    ai.value = res.settings
    aiApiKey.value = ''
  } catch (err) {
    error.value = errorMessage(err)
  }
}

async function testAi() {
  aiTesting.value = true
  aiTestResult.value = null
  try {
    const res = await api.post<{ ok: boolean; reply: string }>('/api/ai/test')
    aiTestResult.value = t('settings.provider_replied', { reply: res.reply })
  } catch (err) {
    aiTestResult.value = errorMessage(err)
  } finally {
    aiTesting.value = false
  }
}

// ----- contacts ----------------------------------------------------------------------
const contacts = ref<ContactInfo[]>([])
const showContactDialog = ref(false)
const editingContactId = ref<string | null>(null)
const savingContact = ref(false)
const contactForm = ref({ email: '', name: '' })

async function loadContacts() {
  const res = await api.get<{ contacts: ContactInfo[] }>('/api/contacts?limit=200')
  contacts.value = res.contacts
}

function openAddContact() {
  editingContactId.value = null
  contactForm.value = { email: '', name: '' }
  showContactDialog.value = true
}

function openEditContact(c: ContactInfo) {
  editingContactId.value = c.id
  contactForm.value = { email: c.email, name: c.name }
  showContactDialog.value = true
}

async function saveContact() {
  error.value = ''
  savingContact.value = true
  try {
    if (editingContactId.value) {
      await api.patch(`/api/contacts/${editingContactId.value}`, {
        name: contactForm.value.name,
        email: contactForm.value.email,
      })
    } else {
      await api.post('/api/contacts', { email: contactForm.value.email, name: contactForm.value.name || undefined })
    }
    showContactDialog.value = false
    await loadContacts()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    savingContact.value = false
  }
}

async function deleteContact(id: string) {
  if (!confirm(t('settings.delete_contact_confirm'))) return
  await api.delete(`/api/contacts/${id}`)
  await loadContacts()
}

onMounted(async () => {
  await Promise.all([loadAccounts(), loadTokens(), loadUsers(), loadAi(), loadContacts(), settingsStore.load()])
})

const refreshIntervalValue = computed({
  get: () => String(settingsStore.refreshIntervalMs),
  set: async (v: string) => {
    try {
      await settingsStore.setRefreshInterval(Number(v))
    } catch (err) {
      error.value = errorMessage(err)
    }
  },
})

const refreshOptions = computed(() =>
  REFRESH_INTERVAL_VALUES.map((v) => ({ value: String(v), label: t(`settings.refresh_${v}`) })),
)

const securityOptions = computed(() => [
  { value: 'tls', label: 'TLS' },
  { value: 'starttls', label: 'STARTTLS' },
  { value: 'none', label: t('settings.security_none') },
])

const providerOptions = computed(() => [
  { value: 'none', label: t('settings.ai_disabled') },
  { value: 'ollama', label: t('settings.ai_ollama') },
  { value: 'openai', label: t('settings.ai_openai') },
])

const tabs = computed(() => [
  { id: 'accounts' as const, label: t('settings.tab_accounts'), icon: MailIcon },
  { id: 'contacts' as const, label: t('settings.tab_contacts'), icon: BookUser },
  { id: 'tokens' as const, label: t('settings.tab_tokens'), icon: KeyRound },
  ...(session.user?.isAdmin ? [{ id: 'users' as const, label: t('settings.tab_users'), icon: UsersIcon }] : []),
  ...(session.user?.isAdmin ? [{ id: 'ai' as const, label: t('settings.tab_ai'), icon: Bot }] : []),
])
</script>

<template>
  <div class="mx-auto max-w-4xl p-6">
    <div class="mb-6 flex items-center gap-3">
      <Button variant="ghost" size="icon" @click="router.push('/')"><ArrowLeft class="h-4 w-4" /></Button>
      <h1 class="text-xl font-semibold">{{ t('settings.title') }}</h1>
    </div>

    <!-- Language & appearance: visible on every tab, saved immediately -->
    <Card class="mb-6 flex flex-wrap items-center justify-between gap-4 p-4">
      <div>
        <p class="flex items-center gap-2 text-sm font-medium"><Languages class="h-4 w-4" /> {{ t('settings.appearance_title') }}</p>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('settings.language_desc') }}</p>
      </div>
      <div class="flex flex-wrap gap-3">
        <div class="w-44">
          <select v-model="locale" class="h-9 w-full rounded-md border bg-card px-2 text-sm" data-testid="language-select" :aria-label="t('settings.language_title')" @change="onLanguageChange">
            <option v-for="l in LOCALES" :key="l" :value="l">{{ LOCALE_NAMES[l] }}</option>
          </select>
        </div>
        <div class="w-44">
          <select v-model="theme" class="h-9 w-full rounded-md border bg-card px-2 text-sm" data-testid="theme-select" :aria-label="t('settings.theme_title')" @change="onThemeChange">
            <option v-for="o in themeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
      </div>
    </Card>

    <div class="mb-6 flex gap-1 border-b">
      <button
        v-for="tab_ in tabs" :key="tab_.id"
        class="flex items-center gap-2 border-b-2 px-3 py-2 text-sm cursor-pointer"
        :class="tab === tab_.id ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'"
        @click="tab = tab_.id"
      >
        <component :is="tab_.icon" class="h-4 w-4" /> {{ tab_.label }}
      </button>
    </div>

    <p v-if="error" class="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{{ error }}</p>

    <!-- Accounts -->
    <div v-if="tab === 'accounts'" class="space-y-4">
      <Card class="p-4">
        <div class="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="flex items-center gap-2 text-sm font-medium"><RefreshCw class="h-4 w-4" /> {{ t('settings.sync_card_title') }}</p>
            <p class="mt-1 text-sm text-muted-foreground">{{ t('settings.sync_card_desc') }}</p>
          </div>
          <div class="w-56">
            <Select v-model="refreshIntervalValue" data-testid="refresh-interval" :options="refreshOptions" />
          </div>
        </div>
      </Card>
      <div class="flex justify-end">
        <Button @click="openAddAccount"><Plus class="h-4 w-4" /> {{ t('settings.add_account') }}</Button>
      </div>
      <Card v-for="a in accounts" :key="a.id" class="p-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <p class="font-medium">{{ a.name }} <span class="ml-2 text-sm text-muted-foreground">{{ a.email }}</span></p>
            <p class="mt-1 text-xs text-muted-foreground">
              IMAP {{ a.imap.host }}:{{ a.imap.port }} ({{ a.imap.tls }}) · SMTP {{ a.smtp.host }}:{{ a.smtp.port }} ({{ a.smtp.tls }})
            </p>
          </div>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" :disabled="testing === a.id" @click="testAccount(a.id)">
              <PlugZap class="h-3.5 w-3.5" /> {{ testing === a.id ? t('settings.testing') : t('settings.test') }}
            </Button>
            <Button variant="outline" size="sm" data-testid="edit-account" @click="openEditAccount(a)">
              <Pencil class="h-3.5 w-3.5" /> {{ t('settings.edit') }}
            </Button>
            <Button variant="ghost" size="icon" @click="deleteAccount(a.id)"><Trash2 class="h-4 w-4 text-destructive" /></Button>
          </div>
        </div>
      </Card>
      <p v-if="testResult" class="text-sm text-muted-foreground">{{ testResult }}</p>
      <p v-if="!accounts.length" class="text-sm text-muted-foreground">{{ t('settings.no_accounts') }}</p>

      <Dialog v-model:open="showAccountDialog" :title="editingId ? t('settings.edit_account_title') : t('settings.add_account_title')" wide :description="editingId ? t('settings.edit_account_desc') : t('settings.add_account_desc')">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-1.5"><Label>{{ t('settings.acc_name') }}</Label><Input v-model="form.name" placeholder="Personal Gmail" /></div>
          <div class="space-y-1.5"><Label>{{ t('settings.acc_email') }}</Label><Input v-model="form.email" type="email" placeholder="you@example.com" /></div>
          <div class="col-span-full mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t('settings.imap_section') }}</div>
          <div class="space-y-1.5"><Label>{{ t('settings.host') }}</Label><Input v-model="form.imapHost" placeholder="imap.example.com" /></div>
          <div class="grid grid-cols-2 gap-2">
            <div class="space-y-1.5"><Label>{{ t('settings.port') }}</Label><Input v-model="form.imapPort" type="number" /></div>
            <div class="space-y-1.5"><Label>{{ t('settings.security') }}</Label>
              <Select v-model="form.imapTls" :options="securityOptions" />
            </div>
          </div>
          <div class="space-y-1.5"><Label>{{ t('settings.username') }}</Label><Input v-model="form.imapUser" :placeholder="t('settings.username_imap_hint')" /></div>
          <div class="space-y-1.5"><Label>{{ t('settings.password_app') }}</Label><Input v-model="form.imapPassword" type="password" :placeholder="editingId ? t('settings.unchanged') : ''" /></div>
          <div class="col-span-full mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t('settings.smtp_section') }}</div>
          <div class="space-y-1.5"><Label>{{ t('settings.host') }}</Label><Input v-model="form.smtpHost" placeholder="smtp.example.com" /></div>
          <div class="grid grid-cols-2 gap-2">
            <div class="space-y-1.5"><Label>{{ t('settings.port') }}</Label><Input v-model="form.smtpPort" type="number" /></div>
            <div class="space-y-1.5"><Label>{{ t('settings.security') }}</Label>
              <Select v-model="form.smtpTls" :options="securityOptions" />
            </div>
          </div>
          <div class="space-y-1.5"><Label>{{ t('settings.username') }} {{ t('settings.username_smtp_hint') }}</Label><Input v-model="form.smtpUser" /></div>
          <div class="space-y-1.5"><Label>{{ t('settings.users_password') }} {{ t('settings.password_smtp_hint') }}</Label><Input v-model="form.smtpPassword" type="password" :placeholder="editingId ? t('settings.unchanged') : ''" /></div>
        </div>
        <div class="mt-6 flex justify-end gap-2">
          <Button variant="outline" @click="showAccountDialog = false">{{ t('common.cancel') }}</Button>
          <Button :disabled="savingAccount || !form.name.trim() || !form.email.trim()" @click="saveAccount">
            {{ savingAccount ? t('settings.saving') : editingId ? t('settings.save') : t('settings.add_account') }}
          </Button>
        </div>
      </Dialog>
    </div>

    <!-- Contacts -->
    <div v-if="tab === 'contacts'" class="space-y-4">
      <Card class="p-4">
        <p class="text-sm font-medium">{{ t('settings.contacts_card_title') }}</p>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('settings.contacts_card_desc') }}</p>
      </Card>
      <div class="flex justify-end">
        <Button @click="openAddContact"><Plus class="h-4 w-4" /> {{ t('settings.new_contact') }}</Button>
      </div>
      <Card v-for="c in contacts" :key="c.id" class="flex items-center justify-between p-3">
        <div class="min-w-0">
          <p class="truncate text-sm font-medium">{{ c.name || c.email }}</p>
          <p class="truncate text-xs text-muted-foreground">
            {{ c.name ? c.email : '' }}
            {{ c.name ? '·' : '' }} {{ t('settings.message_count', { n: c.messageCount }) }}
            {{ c.source === 'manual' ? t('settings.source_manual') : '' }}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon" data-testid="edit-contact" @click="openEditContact(c)"><Pencil class="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" @click="deleteContact(c.id)"><Trash2 class="h-4 w-4 text-destructive" /></Button>
        </div>
      </Card>
      <p v-if="!contacts.length" class="text-sm text-muted-foreground">{{ t('settings.no_contacts') }}</p>

      <Dialog v-model:open="showContactDialog" :title="editingContactId ? t('settings.edit_contact_title') : t('settings.new_contact_title')">
        <div class="space-y-4">
          <div class="space-y-1.5"><Label>{{ t('settings.contact_email') }}</Label><Input v-model="contactForm.email" type="email" placeholder="alice@example.com" /></div>
          <div class="space-y-1.5"><Label>{{ t('settings.contact_name') }}</Label><Input v-model="contactForm.name" :placeholder="t('settings.optional')" /></div>
          <div class="flex justify-end gap-2">
            <Button variant="outline" @click="showContactDialog = false">{{ t('common.cancel') }}</Button>
            <Button :disabled="savingContact || !contactForm.email.trim()" @click="saveContact">{{ savingContact ? t('settings.saving') : t('settings.save') }}</Button>
          </div>
        </div>
      </Dialog>
    </div>

    <!-- Tokens -->
    <div v-if="tab === 'tokens'" class="space-y-6">
      <Card class="p-4">
        <p class="text-sm font-medium">{{ t('settings.tokens_card_title') }}</p>
        <!-- Dictionary-owned markup: static keys, never user data -->
        <p class="mt-1 text-sm text-muted-foreground" v-html="t('settings.tokens_card_desc')" />
      </Card>
      <div class="flex flex-wrap items-end gap-2">
        <div class="space-y-1.5"><Label>{{ t('settings.token_name') }}</Label><Input v-model="newTokenName" placeholder="my-agent" class="w-56" /></div>
        <div class="flex flex-wrap gap-3 pb-2">
          <label v-for="s in ALL_SCOPES" :key="s" class="flex items-center gap-1.5 text-sm">
            <input type="checkbox" v-model="newTokenScopes" :value="s" class="accent-[var(--color-primary)]" /> <code class="text-xs">{{ s }}</code>
          </label>
        </div>
        <Button :disabled="!newTokenName.trim() || !newTokenScopes.length" @click="createToken"><Plus class="h-4 w-4" /> {{ t('settings.create') }}</Button>
      </div>
      <div v-if="createdToken" class="rounded-md border border-primary/40 bg-accent p-4" data-testid="created-token-banner">
        <div class="mb-2 flex items-start justify-between gap-2">
          <p class="text-sm font-medium text-accent-foreground">{{ t('settings.token_created') }}</p>
          <Button variant="ghost" size="icon" :aria-label="t('settings.close')" @click="createdToken = null"><X class="h-4 w-4" /></Button>
        </div>
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 truncate rounded bg-card px-2 py-1 text-xs" data-testid="created-token-value">{{ revealToken ? createdToken : maskedToken }}</code>
          <Button variant="ghost" size="icon" :title="revealToken ? t('settings.mask') : t('settings.unmask')" data-testid="toggle-token-visibility" @click="revealToken = !revealToken">
            <Eye v-if="revealToken" class="h-4 w-4" /><EyeOff v-else class="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" data-testid="copy-token" @click="copyToken"><Check v-if="copied" class="h-3.5 w-3.5" /><Copy v-else class="h-3.5 w-3.5" /> {{ copied ? t('settings.copied') : t('settings.copy') }}</Button>
        </div>
        <p v-if="copyError" class="mt-2 text-xs text-destructive">{{ copyError }}</p>
      </div>
      <div class="space-y-2">
        <Card v-for="token in tokens" :key="token.id" class="flex items-center justify-between p-3">
          <div>
            <p class="text-sm font-medium">{{ token.name }}</p>
            <div class="mt-1 flex flex-wrap gap-1">
              <Badge v-for="s in token.scopes" :key="s" variant="secondary"><code class="text-[10px]">{{ s }}</code></Badge>
            </div>
          </div>
          <div class="text-right">
            <p class="text-xs text-muted-foreground">{{ t('settings.created_at', { date: new Date(token.createdAt).toLocaleDateString() }) }}</p>
            <div class="mt-1 flex justify-end gap-1">
              <Button variant="outline" size="sm" data-testid="edit-scopes" @click="openEditScopes(token)"><ShieldCheck class="h-3.5 w-3.5" /> {{ t('settings.edit_scopes') }}</Button>
              <Button variant="ghost" size="sm" class="text-destructive" @click="revokeToken(token.id)">{{ t('settings.revoke') }}</Button>
            </div>
          </div>
        </Card>
        <p v-if="!tokens.length" class="text-sm text-muted-foreground">{{ t('settings.no_tokens') }}</p>
        <p class="text-xs text-muted-foreground">{{ t('settings.token_hash_note') }}</p>
      </div>

      <Dialog v-model:open="editTokenDialogOpen" :title="t('settings.edit_scopes_title')" :description="t('settings.edit_scopes_desc')">
        <div class="space-y-4">
          <p v-if="editToken" class="text-sm font-medium">{{ editToken.name }}</p>
          <div class="flex flex-wrap gap-3">
            <label v-for="s in ALL_SCOPES" :key="s" class="flex items-center gap-1.5 text-sm">
              <input type="checkbox" v-model="editScopes" :value="s" class="accent-[var(--color-primary)]" data-testid="scope-checkbox" /> <code class="text-xs">{{ s }}</code>
            </label>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="outline" @click="editTokenDialogOpen = false">{{ t('common.cancel') }}</Button>
            <Button :disabled="savingScopes" data-testid="save-scopes" @click="saveScopes">{{ savingScopes ? t('settings.saving') : t('settings.save') }}</Button>
          </div>
        </div>
      </Dialog>
    </div>

    <!-- Users -->
    <div v-if="tab === 'users'" class="space-y-4">
      <Card class="grid gap-3 p-4 sm:grid-cols-2">
        <div class="space-y-1.5"><Label>{{ t('settings.users_email') }}</Label><Input v-model="newUser.email" type="email" /></div>
        <div class="space-y-1.5"><Label>{{ t('settings.users_display_name') }}</Label><Input v-model="newUser.displayName" /></div>
        <div class="space-y-1.5"><Label>{{ t('settings.users_password') }}</Label><Input v-model="newUser.password" type="password" /></div>
        <label class="flex items-end gap-2 pb-2 text-sm">
          <Switch v-model="newUser.isAdmin" /> {{ t('settings.users_admin') }}
        </label>
        <div><Button :disabled="!newUser.email || newUser.password.length < 8" @click="addUser"><Plus class="h-4 w-4" /> {{ t('settings.create_user') }}</Button></div>
      </Card>
      <Card v-for="u in users" :key="u.id" class="flex items-center justify-between p-3">
        <div>
          <p class="text-sm font-medium">{{ u.displayName || u.email }}</p>
          <p class="text-xs text-muted-foreground">{{ u.email }}</p>
        </div>
        <div class="flex items-center gap-3">
          <Badge v-if="u.isAdmin" variant="default">admin</Badge>
          <Button v-if="u.id !== session.user?.id" variant="ghost" size="icon" @click="deleteUser(u.id)">
            <Trash2 class="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </Card>
    </div>

    <!-- AI -->
    <div v-if="tab === 'ai'" class="space-y-4">
      <Card class="grid gap-4 p-4 sm:grid-cols-2">
        <div class="space-y-1.5">
          <Label>{{ t('settings.ai_provider') }}</Label>
          <Select v-model="ai.provider" :options="providerOptions" />
        </div>
        <div class="space-y-1.5"><Label>{{ t('settings.ai_model') }}</Label><Input v-model="ai.model" placeholder="llama3.2 / gpt-4o-mini…" /></div>
        <div class="space-y-1.5 sm:col-span-2">
          <Label>{{ t('settings.ai_base_url') }}</Label>
          <Input v-model="ai.baseUrl" placeholder="http://127.0.0.1:11434 or https://api.openai.com/v1" />
        </div>
        <div class="space-y-1.5">
          <Label>{{ t('settings.ai_api_key') }}</Label>
          <Input v-model="aiApiKey" type="password" :placeholder="t('settings.ai_api_key_ph')" />
        </div>
        <div class="space-y-1.5 sm:col-span-2">
          <Label>{{ t('settings.ai_hint') }}</Label>
          <Input v-model="ai.systemHint" :placeholder="t('settings.ai_hint_ph')" />
        </div>
        <div class="flex gap-2 sm:col-span-2">
          <Button @click="saveAi">{{ t('settings.save') }}</Button>
          <Button variant="outline" :disabled="aiTesting" @click="testAi"><PlugZap class="h-4 w-4" /> {{ aiTesting ? t('settings.testing') : t('settings.test_connection') }}</Button>
        </div>
      </Card>
      <p v-if="aiTestResult" class="text-sm text-muted-foreground">{{ aiTestResult }}</p>
      <Card class="p-4 text-sm text-muted-foreground">{{ t('settings.ai_security_note') }}</Card>
    </div>
  </div>
  <Spinner v-if="false" />
</template>
