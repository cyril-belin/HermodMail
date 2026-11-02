<script setup lang="ts">
import { ref } from 'vue'
import { api, type ContactInfo } from '@/lib/api'
import Input from '@/components/ui/Input.vue'

/**
 * Recipient field with contact autocomplete: suggestions are fetched for the
 * token being typed (text after the last comma) and replace it on selection.
 * Frequents correspondents rank first, exactly like the server-side ranking.
 */
const props = defineProps<{ placeholder?: string; testid?: string }>()
const model = defineModel<string>({ default: '' })

const suggestions = ref<ContactInfo[]>([])
const showSuggestions = ref(false)
const activeIndex = ref(-1)
let debounce: ReturnType<typeof setTimeout> | undefined
let requestSeq = 0

/** Position and text of the token currently being typed. */
function lastToken(): { text: string; start: number } {
  const value = model.value
  const sep = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'))
  return { text: value.slice(sep + 1), start: sep + 1 }
}

function refresh() {
  activeIndex.value = -1
  const { text } = lastToken()
  const q = text.trim()
  if (q.length < 2) {
    suggestions.value = []
    showSuggestions.value = false
    return
  }
  clearTimeout(debounce)
  debounce = setTimeout(async () => {
    const seq = ++requestSeq
    try {
      const res = await api.get<{ contacts: ContactInfo[] }>(`/api/contacts/suggest?q=${encodeURIComponent(q)}&limit=8`)
      if (seq !== requestSeq) return
      suggestions.value = res.contacts
      showSuggestions.value = res.contacts.length > 0
    } catch {
      /* autocomplete is best-effort; never disturbs typing */
    }
  }, 150)
}

function apply(c: ContactInfo) {
  const { start } = lastToken()
  const label = c.name ? `${c.name} <${c.email}>` : c.email
  // Replace the in-progress token; the trailing separator opens the next one.
  model.value = `${model.value.slice(0, start)}${label}, `
  showSuggestions.value = false
  suggestions.value = []
  activeIndex.value = -1
}

function onKeydown(e: KeyboardEvent) {
  if (!showSuggestions.value || !suggestions.value.length) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % suggestions.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = activeIndex.value <= 0 ? suggestions.value.length - 1 : activeIndex.value - 1
  } else if ((e.key === 'Enter' || e.key === 'Tab') && activeIndex.value >= 0) {
    e.preventDefault()
    apply(suggestions.value[activeIndex.value]!)
  } else if (e.key === 'Escape') {
    showSuggestions.value = false
    activeIndex.value = -1
  }
}

/** Close after the blur so a suggestion mousedown (prevented) still lands. */
function onBlur() {
  setTimeout(() => {
    showSuggestions.value = false
    activeIndex.value = -1
  }, 150)
}
</script>

<template>
  <div class="relative">
    <Input
      v-model="model"
      :placeholder="props.placeholder"
      :data-testid="props.testid"
      @input="refresh"
      @focus="refresh"
      @keydown="onKeydown"
      @blur="onBlur"
    />
    <ul
      v-if="showSuggestions && suggestions.length"
      class="absolute z-50 mt-1 max-h-52 w-full overflow-y-auto rounded-md border bg-card py-1 shadow-md"
      data-testid="contact-suggestions"
    >
      <li
        v-for="(c, i) in suggestions" :key="c.id"
        class="flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-sm hover:bg-muted"
        :class="i === activeIndex ? 'bg-muted' : ''"
        @mousedown.prevent="apply(c)"
      >
        <span class="truncate">{{ c.name || c.email }}</span>
        <span v-if="c.name" class="ml-auto shrink-0 text-xs text-muted-foreground">{{ c.email }}</span>
      </li>
    </ul>
  </div>
</template>
