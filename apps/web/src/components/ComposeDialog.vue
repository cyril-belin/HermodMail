<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Send, Loader2, FileDown } from 'lucide-vue-next'
import { api, type Address, type SaveDraftResult } from '@/lib/api'
import { t, errorMessage } from '@/lib/i18n'
import { useAccountsStore } from '@/stores/session'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Label from '@/components/ui/Label.vue'
import Textarea from '@/components/ui/Textarea.vue'
import Dialog from '@/components/ui/Dialog.vue'
import RecipientInput from '@/components/RecipientInput.vue'

const props = defineProps<{
  initial?: {
    accountId?: string
    to?: Address[]
    cc?: Address[]
    subject?: string
    inReplyTo?: string
    references?: string[]
    bodyText?: string
  }
}>()
const open = defineModel<boolean>('open', { default: false })
const accounts = useAccountsStore()

const to = ref('')
const cc = ref('')
const subject = ref('')
const body = ref('')
const attachments = ref<File[]>([])
const busy = ref(false)
const error = ref('')
const success = ref(false)
/** Account used for this draft: the replied-to message's account when given. */
const sendAccountId = computed(() => props.initial?.accountId ?? accounts.activeId)

function parseAddresses(input: string): Address[] {
  return input
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const match = s.match(/^(.*?)\s*<\s*([^\s@]+@[^\s@]+\.[^\s@]+)\s*>$/)
      if (match) return { name: match[1]!.trim().replace(/^"|"$/g, '') || undefined, email: match[2]! }
      return { email: s }
    })
    .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email))
}

const canSend = computed(() => (to.value.trim().length > 0 || cc.value.trim().length > 0) && body.value.trim().length > 0)
/** A draft may be nearly empty — but saving a fully empty one is pointless. */
const canDraft = computed(() => (to.value + cc.value + subject.value + body.value).trim().length > 0)

function prefill() {
  to.value = (props.initial?.to ?? []).map((a) => format(a)).join(', ')
  cc.value = (props.initial?.cc ?? []).map((a) => format(a)).join(', ')
  subject.value = props.initial?.subject ?? ''
  body.value = props.initial?.bodyText ?? ''
  attachments.value = []
  error.value = ''
  success.value = false
  busy.value = false
}

// A parent-driven open (reply buttons) only changes the model — it never emits
// update:open — so prefill must react to the model itself, not to an event.
watch(open, (isOpen) => { if (isOpen) prefill() })

function format(a: Address): string {
  return a.name ? `${a.name} <${a.email}>` : a.email
}

function onFileChange(e: Event) {
  const files = (e.target as HTMLInputElement).files
  attachments.value = files ? Array.from(files) : []
}

async function send() {
  // Hard guards against duplicate sends: the request in flight, or the
  // success window before the dialog closes, must ignore further clicks.
  if (!canSend.value || busy.value || success.value || !sendAccountId.value) return
  busy.value = true
  error.value = ''
  try {
    const payloadAttachments = await Promise.all(
      attachments.value.map(async (f) => ({
        filename: f.name,
        contentType: f.type || 'application/octet-stream',
        contentBase64: await fileToBase64(f),
      })),
    )
    await api.post('/api/send', {
      accountId: sendAccountId.value,
      to: parseAddresses(to.value),
      cc: cc.value.trim() ? parseAddresses(cc.value) : undefined,
      subject: subject.value,
      text: body.value,
      inReplyTo: props.initial?.inReplyTo,
      references: props.initial?.references?.length ? props.initial.references : undefined,
      attachments: payloadAttachments.length ? payloadAttachments : undefined,
    })
    // Close immediately: a lingering success window (disabled buttons, no
    // way out) is exactly the trap users hit on slow SMTP links. The
    // busy/success guards above already block duplicate sends.
    success.value = true
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error(`Cannot read ${file.name}`))
    reader.readAsDataURL(file)
  })
}

const savingDraft = ref(false)

/**
 * Save a real IMAP draft (Drafts folder, \Draft flag) without sending: the
 * message stays editable here and in any other mail client. Same guards as
 * send against duplicate clicks.
 */
async function saveDraft() {
  if (!canDraft.value || busy.value || savingDraft.value || success.value || !sendAccountId.value) return
  savingDraft.value = true
  error.value = ''
  try {
    await api.post<SaveDraftResult>('/api/drafts', {
      accountId: sendAccountId.value,
      to: parseAddresses(to.value),
      cc: cc.value.trim() ? parseAddresses(cc.value) : undefined,
      subject: subject.value,
      text: body.value,
      inReplyTo: props.initial?.inReplyTo,
      references: props.initial?.references?.length ? props.initial.references : undefined,
    })
    open.value = false
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    savingDraft.value = false
  }
}

</script>

<template>
  <Dialog v-model:open="open" :title="initial?.inReplyTo ? t('compose.reply_title') : t('compose.new_title')" class="max-w-2xl">
    <div class="space-y-3">
      <p v-if="sendAccountId" class="text-xs text-muted-foreground">
        {{ t('compose.from', { name: accounts.accounts.find((a) => a.id === sendAccountId)?.name || sendAccountId }) }}
      </p>
      <div class="space-y-1.5">
        <Label>{{ t('compose.to') }}</Label>
        <RecipientInput v-model="to" placeholder="alice@example.com, Bob <bob@example.com>" testid="compose-to" />
      </div>
      <div class="space-y-1.5">
        <Label>{{ t('compose.cc') }}</Label>
        <RecipientInput v-model="cc" :placeholder="t('settings.optional')" testid="compose-cc" />
      </div>
      <div class="space-y-1.5">
        <Label>{{ t('compose.subject') }}</Label>
        <Input v-model="subject" :placeholder="t('compose.subject_placeholder')" />
      </div>
      <Textarea v-model="body" :rows="10" :placeholder="t('compose.body_placeholder')" />
      <div class="space-y-1.5">
        <Label>{{ t('compose.attachments') }}</Label>
        <input type="file" multiple class="text-sm" @change="onFileChange" />
        <p v-if="attachments.length" class="text-xs text-muted-foreground">{{ t('compose.files_attached', { n: attachments.length }) }}</p>
      </div>
      <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
      <p v-if="success" class="text-sm text-primary">{{ t('compose.sent') }}</p>
      <div class="flex justify-end gap-2">
        <!-- Cancel stays clickable while a send is in flight: a slow SMTP
             link must never trap the user in the dialog. -->
        <Button variant="outline" :disabled="success" @click="open = false">{{ t('common.cancel') }}</Button>
        <Button variant="outline" :disabled="!canDraft || busy || savingDraft || success" data-testid="save-draft-button" @click="saveDraft">
          <Loader2 v-if="savingDraft" class="h-4 w-4 animate-spin" /><FileDown v-else class="h-4 w-4" />
          {{ savingDraft ? t('compose.saving_draft') : t('compose.save_draft') }}
        </Button>
        <Button :disabled="!canSend || busy || success" data-testid="send-button" @click="send">
          <Loader2 v-if="busy" class="h-4 w-4 animate-spin" /><Send v-else class="h-4 w-4" />
          {{ busy ? t('compose.sending') : t('compose.send') }}
        </Button>
      </div>
    </div>
  </Dialog>
</template>
