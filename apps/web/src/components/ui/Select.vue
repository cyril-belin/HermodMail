<script setup lang="ts">
import { cn } from '@/lib/utils'
const props = withDefaults(defineProps<{ class?: string; modelValue?: string | number; options: { value: string | number; label: string }[]; disabled?: boolean }>(), {})
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()
</script>

<template>
  <select
    :value="modelValue"
    :disabled="disabled"
    :class="cn('flex h-9 w-full rounded-md border bg-card px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', props.class)"
    @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
  >
    <option v-for="opt in options" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
  </select>
</template>
