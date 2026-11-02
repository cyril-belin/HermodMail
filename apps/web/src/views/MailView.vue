<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  Inbox, Star, FileText, Send, Trash2, Archive, FolderPlus, RefreshCw, Settings, LogOut,
  PenSquare, Search, Mail as MailIcon, MailOpen, Paperclip, ChevronDown, AlertTriangle, Sparkles,
  Reply, ReplyAll, Languages,
} from 'lucide-vue-next'
import { useSessionStore, useAccountsStore, useSettingsStore } from '@/stores/session'
import { api, type MessageSummary, type MessageDetail, type Address } from '@/lib/api'
import { t, errorMessage, locale, LOCALES, LOCALE_NAMES, type Locale } from '@/lib/i18n'
import { detectLanguage } from '@/lib/langdetect'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Badge from '@/components/ui/Badge.vue'
import Dialog from '@/components/ui/Dialog.vue'
import Spinner from '@/components/ui/Spinner.vue'
import { cn, formatDate, formatAddress, formatSize } from '@/lib/utils'
import ComposeDialog from '@/components/ComposeDialog.vue'
import MarkdownText from '@/components/MarkdownText.vue'

const session = useSessionStore()
const accounts = useAccountsStore()
const settings = useSettingsStore()
const router = useRouter()

// ----- state ---------------------------------------------------------------
const selectedFolder = ref('INBOX')
const messages = ref<MessageSummary[]>([])
const total = ref(0)
const page = ref(1)
const limit = 50
const loading = ref(false)
const syncing = ref(false)
const error = ref('')
const filter = ref<'all' | 'unseen' | 'flagged' | 'attachments'>('all')
const searchQuery = ref('')
const searchResults = ref<MessageSummary[] | null>(null)
const selected = ref<MessageDetail | null>(null)
const loadingMessage = ref(false)
const showCompose = ref(false)
const composeInitial = ref<{
  accountId?: string; to?: Address[]; cc?: Address[]; subject?: string
  inReplyTo?: string; references?: string[]; bodyText?: string
}>({})
const showFolderCreate = ref(false)
const newFolderPath = ref('')
const aiBusy = ref(false)
const aiPanel = ref<{ kind: 'summary' | 'draft'; text: string } | null>(null)

const specialIcons: Record<string, typeof Inbox> = {
  inbox: Inbox, flag: Star, drafts: FileText, sent: Send, trash: Trash2, archive: Archive, junk: AlertTriangle,
}

const specialOrder = ['inbox', 'flag', 'sent', 'drafts', 'archive', 'junk', 'trash']
const specialFolders = computed(() => {
  const found = new Map<string, (typeof accounts.folders)[number]>()
  for (const f of accounts.folders) {
    if (f.specialUse && !found.has(f.specialUse)) found.set(f.specialUse, f)
  }
  return specialOrder
    .map((use) => found.get(use))
    .filter((f): f is NonNullable<typeof f> => !!f)
})
const otherFolders = computed(() => {
  const specialPaths = new Set(specialFolders.value.map((f) => f.id))
  return accounts.folders.filter((f) => !specialPaths.has(f.id))
})

const activeAccount = computed(() => accounts.accounts.find((a) => a.id === accounts.activeId))

// ----- actions --------------------------------------------------------------

const E2E_MARKER_9F3 = "e2e-marker"
async function boot() {
  await accounts.refresh()
  try {
    await accounts.loadFolders(true)
  } catch {
    // Server-side folder refresh failed (offline, older backend…): fall back
    // to the cached list instead of leaving the sidebar empty.
    await accounts.loadFolders().catch(() => {})
  }
  if (!accounts.accounts.length) {
    router.push('/settings')
    return
  }
  // Load the initial folder view — nothing else triggers it on first render.
  await selectFolder(selectedFolder.value)
}

async function selectFolder(path: string) {
  selectedFolder.value = path
  selected.value = null
  searchResults.value = null
  searchQuery.value = ''
  page.value = 1
  await loadMessages(true)
}

async function loadMessages(sync = false) {
  if (!accounts.activeId) return
  loading.value = true
  error.value = ''
  try {
    const res = await api.get<{ messages: MessageSummary[]; total: number }>(
      `/api/accounts/${accounts.activeId}/messages?folder=${encodeURIComponent(selectedFolder.value)}&page=${page.value}&limit=${limit}&filter=${filter.value}&sync=${sync}`,
    )
    messages.value = res.messages
    total.value = res.total
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loading.value = false
    void accounts.loadFolders() // refresh unread badges
  }
}

async function resync() {
  if (!accounts.activeId || syncing.value) return
  syncing.value = true
  try {
    await api.post(`/api/accounts/${accounts.activeId}/sync`, { folder: selectedFolder.value })
    await loadMessages(false)
  } catch (err) {
    // Keep cached data on network failure; the banner shows why the refresh failed.
    error.value = errorMessage(err)
  } finally {
    syncing.value = false
  }
}

// ----- automatic refresh (interval configured in Settings) ------------------

let refreshTimer: ReturnType<typeof setInterval> | undefined

function restartRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer)
  const ms = settings.refreshIntervalMs
  if (!ms || ms <= 0) return // manual only
  refreshTimer = setInterval(() => {
    if (document.hidden) return
    void resync()
  }, ms)
}

onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer) })

async function openMessage(m: MessageSummary) {
  if (!accounts.activeId) return
  loadingMessage.value = true
  aiPanel.value = null
  try {
    selected.value = await api.get<MessageDetail>(
      `/api/accounts/${accounts.activeId}/messages/${encodeURIComponent(m.folderPath)}/${m.uid}`,
    )
    m.seen = true
    void accounts.loadFolders()
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    loadingMessage.value = false
  }
}

async function toggleFlag(m: MessageSummary) {
  if (!accounts.activeId) return
  await api.patch(`/api/accounts/${accounts.activeId}/messages/${encodeURIComponent(m.folderPath)}/${m.uid}`, { flagged: !m.flagged })
  m.flagged = !m.flagged
}

async function toggleSeen(m: MessageSummary) {
  if (!accounts.activeId) return
  await api.patch(`/api/accounts/${accounts.activeId}/messages/${encodeURIComponent(m.folderPath)}/${m.uid}`, { seen: !m.seen })
  m.seen = !m.seen
  void accounts.loadFolders()
}

async function deleteMessage(m: MessageSummary) {
  if (!accounts.activeId) return
  await api.delete(`/api/accounts/${accounts.activeId}/messages/${encodeURIComponent(m.folderPath)}/${m.uid}`)
  messages.value = messages.value.filter((x) => x.id !== m.id)
  if (selected.value?.id === m.id) selected.value = null
  void accounts.loadFolders()
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(searchQuery, (q) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(async () => {
    if (!q.trim()) { searchResults.value = null; return }
    try {
      const res = await api.get<{ results: MessageSummary[] }>(`/api/search?q=${encodeURIComponent(q)}${accounts.activeId ? `&accountId=${accounts.activeId}` : ''}`)
      searchResults.value = res.results
    } catch { searchResults.value = [] }
  }, 300)
})

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Reply-To when present and valid, else From (RFC 5322 reply semantics). */
function replyRecipients(m: MessageDetail): Address[] {
  const fromReplyTo = (m.replyTo ?? []).filter((a) => EMAIL_RE.test(a.email))
  return fromReplyTo.length ? fromReplyTo : (m.from ?? []).filter((a) => EMAIL_RE.test(a.email))
}

function buildReSubject(subject: string): string {
  return /^(re|aw|r\u00e9p)\s*(\[\d+\])?\s*:/i.test(subject) ? subject : `Re: ${subject}`
}

function quoteBody(m: MessageDetail): string {
  const who = formatAddress(m.from[0] ?? { email: '' })
  const when = m.date ? new Date(m.date).toLocaleString() : ''
  const quoted = (m.bodyText ?? '').slice(0, 2000)
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')
  return `\n\n---\n${t('reader.quote_prefix', { when, who })}\n${quoted}`
}

function replyTo(m: MessageDetail) {
  composeInitial.value = {
    accountId: m.accountId,
    to: replyRecipients(m),
    subject: buildReSubject(m.subject),
    inReplyTo: m.messageId ?? undefined,
    references: [...(m.references ?? []), ...(m.messageId ? [m.messageId] : [])],
    bodyText: quoteBody(m),
  }
  showCompose.value = true
}

function replyAll(m: MessageDetail) {
  const selfEmails = new Set(accounts.accounts.map((a) => a.email.toLowerCase()))
  const isSelf = (a: Address) => selfEmails.has(a.email.toLowerCase())
  const primary = replyRecipients(m)
  const primaryEmails = new Set(primary.map((a) => a.email.toLowerCase()))
  const seenEmails = new Set([...primaryEmails, ...selfEmails])
  const others: Address[] = []
  for (const a of [...m.to, ...m.cc]) {
    const email = a.email.toLowerCase()
    if (!EMAIL_RE.test(a.email) || seenEmails.has(email)) continue
    seenEmails.add(email)
    others.push(a)
  }
  composeInitial.value = {
    accountId: m.accountId,
    to: primary,
    cc: others,
    subject: buildReSubject(m.subject),
    inReplyTo: m.messageId ?? undefined,
    references: [...(m.references ?? []), ...(m.messageId ? [m.messageId] : [])],
    bodyText: quoteBody(m),
  }
  showCompose.value = true
}

function newMessage() {
  composeInitial.value = {}
  showCompose.value = true
}

/**
 * Resume editing an IMAP draft: re-opens the composer prefilled with the
 * draft's recipients, subject, threading refs and body. Sending creates the
 * final message; the original draft remains in Drafts until deleted by hand.
 */
function resumeDraft(m: MessageDetail) {
  composeInitial.value = {
    accountId: m.accountId,
    to: (m.to ?? []).filter((a) => EMAIL_RE.test(a.email)),
    cc: (m.cc ?? []).filter((a) => EMAIL_RE.test(a.email)),
    subject: m.subject ?? '',
    inReplyTo: m.inReplyTo ?? undefined,
    references: m.references?.length ? m.references : undefined,
    bodyText: m.bodyText ?? '',
  }
  showCompose.value = true
}

/**
 * "Use this reply": injects the AI proposal into the existing composer as a
 * reply (recipient with Reply-To, Re: subject, In-Reply-To/References kept so
 * conversation threading still works). The draft is never sent automatically —
 * the user reviews and sends it themselves.
 */
function useAiReply() {
  const m = selected.value
  const draft = aiPanel.value?.kind === 'draft' ? aiPanel.value.text : null
  if (!m || !draft) return
  // A dialog already open may hold user-edited content — never overwrite it silently.
  if (showCompose.value && !confirm(t('reader.use_reply_confirm'))) return
  composeInitial.value = {
    accountId: m.accountId,
    to: replyRecipients(m),
    subject: buildReSubject(m.subject),
    inReplyTo: m.messageId ?? undefined,
    references: [...(m.references ?? []), ...(m.messageId ? [m.messageId] : [])],
    bodyText: draft,
  }
  showCompose.value = true
}

async function runAi(kind: 'summarize' | 'draft') {
  if (!accounts.activeId || !selected.value) return
  aiBusy.value = true
  const panelKind = kind === 'summarize' ? ('summary' as const) : ('draft' as const)
  try {
    const body = { accountId: accounts.activeId, folder: selected.value.folderPath, uid: selected.value.uid }
    if (kind === 'summarize') {
      const res = await api.post<{ summary: string }>('/api/ai/summarize', body)
      aiPanel.value = { kind: panelKind, text: res.summary }
      selected.value.summary = res.summary
    } else {
      const res = await api.post<{ draft: string }>('/api/ai/draft', body)
      aiPanel.value = { kind: panelKind, text: res.draft }
    }
  } catch (err) {
    aiPanel.value = { kind: panelKind, text: errorMessage(err) }
  } finally {
    aiBusy.value = false
  }
}

// ----- message translation (user-triggered only) ------------------------------

const translating = ref(false)
const showTranslation = ref(false)
const transTarget = ref<Locale>('fr')
const translateError = ref('')

/** AI-free heuristic: is this message worth a Translate button? */
const detectedLang = computed(() => {
  const m = selected.value
  if (!m) return null
  return detectLanguage(m.bodyText ?? m.bodyHtml ?? m.snippet)
})

/** Offer the button for any message that is not (or may not be) in the UI language. */
const offerTranslate = computed(() => {
  const m = selected.value
  if (!m || m.draft) return false
  const d = detectedLang.value
  return d !== null && d !== locale.value
})

/**
 * The primary "Translate to X" button: only when the selected target is not
 * already cached and differs from the detected language — a same-language
 * message with an old cached translation shows the toggle, not a new button.
 */
const showTranslateButton = computed(() => {
  const d = detectedLang.value
  if (d === null || d === transTarget.value) return false
  return !cachedTranslation.value
})

const cachedTranslation = computed(() => {
  const tr = selected.value?.translation
  return tr && tr.target === transTarget.value ? tr : null
})

/** Switching target auto-shows the translation when it is already cached. */
watch(transTarget, () => {
  if (cachedTranslation.value) showTranslation.value = true
})

const displayBody = computed<{ html: string | null; text: string | null }>(() => {
  const tr = showTranslation.value ? cachedTranslation.value : null
  if (tr) return { html: tr.html ?? null, text: tr.text ?? null }
  return { html: selected.value?.bodyHtml ?? null, text: selected.value?.bodyText ?? null }
})

function langLabel(code: string): string {
  return code === 'fr' ? t('translate.lang_fr') : code === 'en' ? t('translate.lang_en') : code === 'es' ? t('translate.lang_es') : t('translate.lang_unknown')
}

/** Describe the translation currently shown, else the newest cached one. */
const bannerText = computed(() => {
  const shown = showTranslation.value ? cachedTranslation.value : null
  const tr = shown ?? selected.value?.translation
  if (!tr) return ''
  return tr.from === 'unknown'
    ? t('translate.banner_unknown_source', { to: langLabel(tr.target) })
    : t('translate.banner', { from: langLabel(tr.from), to: langLabel(tr.target) })
})

watch(selected, () => {
  showTranslation.value = false
  translateError.value = ''
  transTarget.value = locale.value
})

async function translateMessage() {
  const m = selected.value
  if (!m || !accounts.activeId || translating.value) return
  translating.value = true
  translateError.value = ''
  try {
    const res = await api.post<{ translation: NonNullable<MessageDetail['translation']> }>('/api/ai/translate', {
      accountId: m.accountId,
      folder: m.folderPath,
      uid: m.uid,
      target: transTarget.value,
    })
    m.translation = res.translation
    showTranslation.value = true
  } catch (err) {
    translateError.value = errorMessage(err)
  } finally {
    translating.value = false
  }
}

async function createFolder() {
  if (!accounts.activeId || !newFolderPath.value.trim()) return
  await api.post(`/api/accounts/${accounts.activeId}/folders`, { path: newFolderPath.value.trim() })
  showFolderCreate.value = false
  newFolderPath.value = ''
  await accounts.loadFolders()
}

async function switchAccount(id: string) {
  accounts.activeId = id
  selected.value = null
  selectedFolder.value = 'INBOX'
  await accounts.loadFolders(true)
  await loadMessages(true)
}

async function logout() {
  await session.logout()
  accounts.$reset()
  router.push('/login')
}

onMounted(async () => {
  // A missing /api/settings (e.g. backend older than frontend) must never
  // prevent the mailbox itself from loading.
  try {
    await settings.load()
  } catch {
    /* keep the 60s default */
  }
  restartRefreshTimer()
  await boot()
})
watch(filter, () => { page.value = 1; void loadMessages(false) })
watch(() => settings.refreshIntervalMs, restartRefreshTimer)
</script>

<template>
  <div class="flex h-screen flex-col">
    <!-- Top bar -->
    <header class="flex h-14 items-center gap-3 border-b bg-card px-4">
      <div class="flex items-center gap-2 font-semibold">
        <div class="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <MailIcon class="h-4 w-4" />
        </div>
        HermodMail
      </div>
      <select
        v-if="accounts.accounts.length > 1"
        class="h-8 rounded-md border bg-card px-2 text-sm"
        :value="accounts.activeId ?? ''"
        @change="switchAccount(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="a in accounts.accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
      </select>
      <div class="relative ml-auto w-full max-w-sm">
        <Search class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="searchQuery" :placeholder="t('nav.search_placeholder')" class="pl-8" />
      </div>
      <Button variant="outline" size="sm" @click="newMessage"><PenSquare class="h-4 w-4" /> {{ t('nav.compose') }}</Button>
      <router-link to="/settings"><Button variant="ghost" size="icon" :title="t('nav.settings')"><Settings class="h-4 w-4" /></Button></router-link>
      <Button variant="ghost" size="icon" :title="t('nav.sign_out', { email: session.user?.email ?? '' })" @click="logout"><LogOut class="h-4 w-4" /></Button>
    </header>

    <div class="flex min-h-0 flex-1">
      <!-- Folders -->
      <aside class="hidden w-60 shrink-0 flex-col border-r bg-card md:flex">
        <div class="flex-1 overflow-y-auto p-2">
          <button
            v-for="f in specialFolders" :key="f.id"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted cursor-pointer"
            :class="selectedFolder === f.path && !searchResults ? 'bg-muted font-medium' : ''"
            @click="selectFolder(f.path)"
          >
            <component :is="specialIcons[f.specialUse ?? 'inbox'] ?? FolderPlus" class="h-4 w-4 text-muted-foreground" />
            <span class="flex-1 truncate text-left">{{ f.path }}</span>
            <Badge v-if="f.unreadCount" variant="default" class="h-5 min-w-5 justify-center px-1">{{ f.unreadCount }}</Badge>
          </button>
          <div class="mt-3 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t('folders.title') }}</div>
          <button
            v-for="f in otherFolders" :key="f.id"
            class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted cursor-pointer"
            :class="selectedFolder === f.path && !searchResults ? 'bg-muted font-medium' : ''"
            @click="selectFolder(f.path)"
          >
            <FolderPlus class="h-4 w-4 text-muted-foreground" />
            <span class="flex-1 truncate text-left">{{ f.path }}</span>
            <Badge v-if="f.unreadCount" variant="default" class="h-5 min-w-5 justify-center px-1">{{ f.unreadCount }}</Badge>
          </button>
        </div>
        <div class="border-t p-2">
          <Button variant="ghost" size="sm" class="w-full justify-start" @click="showFolderCreate = true"><FolderPlus class="h-4 w-4" /> {{ t('folders.new_folder') }}</Button>
          <Button variant="ghost" size="sm" class="w-full justify-start" :disabled="syncing" data-testid="refresh-button" @click="resync">
            <RefreshCw class="h-4 w-4" :class="syncing ? 'animate-spin' : ''" /> {{ syncing ? t('folders.refreshing') : t('folders.refresh') }}
          </Button>
        </div>
      </aside>

      <!-- Message list -->
      <section class="flex w-full min-w-0 flex-col border-r md:w-96 md:shrink-0">
        <div class="flex h-11 items-center gap-2 border-b px-3">
          <select v-model="filter" class="h-7 rounded-md border bg-card px-2 text-xs">
            <option value="all">{{ t('list.filter_all') }}</option>
            <option value="unseen">{{ t('list.filter_unseen') }}</option>
            <option value="flagged">{{ t('list.filter_flagged') }}</option>
            <option value="attachments">{{ t('list.filter_attachments') }}</option>
          </select>
          <span class="ml-auto text-xs text-muted-foreground">{{ t('list.count', { n: total }) }}</span>
        </div>
        <div v-if="error" class="border-b bg-destructive/10 px-3 py-2 text-sm text-destructive">{{ error }}</div>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <Spinner v-if="loading" :text="t('list.loading')" />
          <template v-else>
            <p v-if="searchResults" class="border-b bg-accent px-3 py-1.5 text-xs text-accent-foreground">
              {{ t('list.results', { n: searchResults.length }) }}<button class="underline cursor-pointer" @click="searchResults = null; searchQuery = ''">{{ t('list.clear') }}</button>
            </p>
            <button
              v-for="m in (searchResults ?? messages)" :key="m.id"
              class="flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left hover:bg-muted/60 cursor-pointer"
              :class="selected?.id === m.id ? 'bg-accent' : m.seen ? '' : 'bg-primary/[0.04]'"
              @click="openMessage(m)"
            >
              <div class="flex w-full items-center gap-2">
                <span v-if="!m.seen" class="h-2 w-2 shrink-0 rounded-full bg-primary" :title="t('list.unread_title')" />
                <span v-else class="h-2 w-2 shrink-0" />
                <span class="truncate text-sm" :class="m.seen ? 'font-normal' : 'font-semibold'">
                  {{ formatAddress(m.from[0] ?? { email: t('list.unknown_recipient') }) }}
                </span>
                <span class="ml-auto shrink-0 text-xs text-muted-foreground">{{ formatDate(m.date) }}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <Star v-if="m.flagged" class="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" />
                <Paperclip v-if="m.hasAttachments" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span class="truncate text-sm" :class="m.seen ? '' : 'font-semibold'">{{ m.subject || t('list.no_subject') }}</span>
              </div>
              <p class="line-clamp-2 text-xs text-muted-foreground">{{ m.snippet }}</p>
              <div class="flex gap-1">
                <Badge v-if="m.summary" variant="secondary" class="gap-1"><Sparkles class="h-3 w-3" /> {{ t('list.summarized') }}</Badge>
              </div>
            </button>
            <div v-if="!(searchResults ?? messages).length" class="p-8 text-center text-sm text-muted-foreground">{{ t('list.no_messages') }}</div>
            <div v-if="!searchResults && messages.length >= limit" class="flex justify-center border-t p-2">
              <div class="flex gap-2">
                <Button variant="outline" size="sm" :disabled="page <= 1" @click="page--; loadMessages(false)">{{ t('list.newer') }}</Button>
                <Button variant="outline" size="sm" :disabled="page * limit >= total" @click="page++; loadMessages(false)">{{ t('list.older') }}</Button>
              </div>
            </div>
          </template>
        </div>
      </section>

      <!-- Reader -->
      <section class="hidden min-w-0 flex-1 flex-col lg:flex">
        <template v-if="loadingMessage"><Spinner :text="t('reader.fetching')" /></template>
        <template v-else-if="selected">
          <div class="flex items-start gap-3 border-b p-4">
            <div class="min-w-0 flex-1">
              <h2 class="text-lg font-semibold">{{ selected.subject || t('list.no_subject') }}</h2>
              <p class="mt-1 text-sm text-muted-foreground">
                <strong class="text-foreground">{{ formatAddress(selected.from[0] ?? { email: '' }) }}</strong>
                · {{ t('reader.to', { recipients: selected.to.map((a) => a.email).join(', ') || t('list.unknown_recipient') }) }}
                · {{ selected.date ? new Date(selected.date).toLocaleString() : '' }}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <Button variant="ghost" size="icon" :title="selected.flagged ? t('reader.unflag') : t('reader.flag')" @click="toggleFlag(selected)">
                <Star class="h-4 w-4" :class="selected.flagged ? 'fill-amber-400 text-amber-400' : ''" />
              </Button>
              <Button variant="ghost" size="icon" :title="selected.seen ? t('reader.mark_unread') : t('reader.mark_read')" @click="toggleSeen(selected)">
                <MailOpen v-if="selected.seen" class="h-4 w-4" /><MailIcon v-else class="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" :title="t('reader.reply')" data-testid="reply-button" @click="replyTo(selected)"><Reply class="h-4 w-4" /></Button>
              <Button variant="ghost" size="icon" :title="t('reader.reply_all')" data-testid="reply-all-button" @click="replyAll(selected)"><ReplyAll class="h-4 w-4" /></Button>
              <Button v-if="selected.draft" variant="ghost" size="icon" :title="t('reader.edit_draft')" data-testid="resume-draft" @click="resumeDraft(selected)"><FileText class="h-4 w-4" /></Button>
              <Button variant="ghost" size="icon" :title="t('reader.delete')" @click="deleteMessage(selected)"><Trash2 class="h-4 w-4 text-destructive" /></Button>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 border-b px-4 py-1.5">
            <Button variant="outline" size="sm" :disabled="aiBusy" @click="runAi('summarize')">
              <Sparkles class="h-3.5 w-3.5" /> {{ aiBusy && aiPanel?.kind === 'summary' ? t('reader.thinking') : t('reader.ai_summary') }}
            </Button>
            <Button variant="outline" size="sm" :disabled="aiBusy" @click="runAi('draft')">
              <PenSquare class="h-3.5 w-3.5" /> {{ aiBusy && aiPanel?.kind === 'draft' ? t('reader.thinking') : t('reader.ai_draft') }}
            </Button>
            <!-- Translation: offered only for messages detected as foreign -->
            <template v-if="offerTranslate || selected.translation">
              <span v-if="showTranslateButton" class="flex items-center gap-1 text-xs text-muted-foreground">
                <select v-model="transTarget" class="h-7 rounded-md border bg-card px-1.5 text-xs" data-testid="translate-target">
                  <option v-for="l in LOCALES" :key="l" :value="l">{{ LOCALE_NAMES[l] }}</option>
                </select>
              </span>
              <Button
                v-if="showTranslateButton"
                variant="outline" size="sm" :disabled="translating" data-testid="translate-button" @click="translateMessage"
              >
                <Languages class="h-3.5 w-3.5" /> {{ translating ? t('translate.busy') : t('translate.target_label') + ' ' + LOCALE_NAMES[transTarget] }}
              </Button>
            </template>
          </div>
          <div v-if="translateError" class="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">{{ translateError }}</div>
          <div v-if="selected.translation" class="flex flex-wrap items-center gap-2 border-b bg-accent px-4 py-1.5">
            <p class="text-xs font-medium text-accent-foreground">
              {{ bannerText }}
            </p>
            <div class="ml-auto flex gap-1">
              <Button variant="outline" size="sm" :class="!showTranslation ? 'bg-card' : ''" data-testid="show-original" @click="showTranslation = false">{{ t('translate.show_original') }}</Button>
              <Button variant="outline" size="sm" :class="showTranslation ? 'bg-card' : ''" data-testid="show-translation" @click="showTranslation = true">{{ t('translate.show_translation') }}</Button>
            </div>
          </div>
          <div v-if="aiPanel" class="border-b bg-accent px-4 py-3">
            <p class="mb-1 flex items-center gap-1 text-xs font-medium text-accent-foreground">
              <Sparkles class="h-3 w-3" /> {{ aiPanel.kind === 'summary' ? t('reader.ai_summary') : t('reader.ai_draft') }}
            </p>
            <!-- Markdown rendered as inert DOM (never HTML from the model) -->
            <MarkdownText :text="aiPanel.text" />
            <div v-if="aiPanel.kind === 'draft'" class="mt-2 flex justify-end">
              <Button size="sm" data-testid="use-ai-reply" @click="useAiReply">
                <PenSquare class="h-3.5 w-3.5" /> {{ t('reader.use_reply') }}
              </Button>
            </div>
          </div>
          <div v-if="selected.attachments.length" class="flex flex-wrap gap-2 border-b px-4 py-2">
            <a
              v-for="att in selected.attachments"
              :key="att.id + att.filename"
              :href="att.id.startsWith('oversize:') ? undefined : `/api/attachments/${accounts.activeId}/${att.id}`"
              :class="att.id.startsWith('oversize:') ? 'inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs opacity-50' : 'inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-1 text-xs hover:bg-muted'"
              :title="att.id.startsWith('oversize:') ? t('reader.attachment_oversize') : t('reader.download')"
            >
              <Paperclip class="h-3 w-3" /> {{ att.filename }}
              <span class="text-muted-foreground">({{ formatSize(att.size) }})</span>
            </a>
          </div>
          <div class="min-h-0 flex-1 overflow-y-auto p-4">
            <!-- bodyHtml is sanitized server-side (originals by sanitize-html,
                 translations re-sanitized after the model returns them) -->
            <div v-if="displayBody.html" class="email-body" v-html="displayBody.html" />
            <p v-else-if="displayBody.text" class="email-body whitespace-pre-wrap">{{ displayBody.text }}</p>
            <p v-else class="text-sm italic text-muted-foreground">{{ t('reader.no_body') }}</p>
          </div>
        </template>
        <div v-else class="flex h-full items-center justify-center text-muted-foreground">
          <div class="text-center">
            <Inbox class="mx-auto mb-2 h-10 w-10 opacity-30" />
            <p class="text-sm">{{ t('reader.select_message') }}</p>
          </div>
        </div>
      </section>
    </div>

    <ComposeDialog v-model:open="showCompose" :initial="composeInitial" />
    <Dialog v-model:open="showFolderCreate" :title="t('folders.create_title')" :description="t('folders.create_desc')">
      <div class="space-y-4">
        <Input v-model="newFolderPath" :placeholder="t('folders.name_placeholder')" @keydown.enter="createFolder" />
        <div class="flex justify-end gap-2">
          <Button variant="outline" @click="showFolderCreate = false">{{ t('common.cancel') }}</Button>
          <Button @click="createFolder">{{ t('common.create') }}</Button>
        </div>
      </div>
    </Dialog>
  </div>
</template>
