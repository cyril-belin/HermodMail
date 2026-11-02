<script setup lang="ts">
import { cn } from '@/lib/utils'
const props = defineProps<{ class?: string; modelValue?: string | number; type?: string; placeholder?: string; disabled?: boolean; required?: boolean; autofocus?: boolean; id?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()
</script>

<template>
  <input
    :id="id"
    :type="props.type ?? 'text'"
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :required="required"
    :autofocus="autofocus"
    :class="cn('flex h-9 w-full rounded-md border bg-card px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', props.class)"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>
