<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{ modelValue?: boolean; class?: string; disabled?: boolean; id?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()
const checked = computed(() => props.modelValue ?? false)
</script>

<template>
  <button
    :id="id"
    type="button"
    role="switch"
    :aria-checked="checked"
    :disabled="disabled"
    :class="cn('inline-flex h-5 w-9 shrink-0 items-center rounded-full border-2 border-transparent transition-colors cursor-pointer disabled:opacity-50', checked ? 'bg-primary' : 'bg-muted-foreground/30', props.class)"
    @click="emit('update:modelValue', !checked)"
  >
    <span :class="cn('pointer-events-none block h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0')" />
  </button>
</template>
