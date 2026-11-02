<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { renderMarkdown } from '@/lib/markdown'

/**
 * Renders AI-generated Markdown as styled DOM. The renderer never interprets
 * HTML — content is attached as text nodes, so model output stays inert.
 */
const props = defineProps<{ text: string }>()
const host = ref<HTMLElement | null>(null)

function mount() {
  if (host.value) host.value.replaceChildren(renderMarkdown(props.text))
}

onMounted(mount)
watch(() => props.text, mount)
</script>

<template>
  <div ref="host" class="markdown-text" />
</template>
