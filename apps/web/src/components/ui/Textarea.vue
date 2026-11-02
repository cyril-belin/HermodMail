<script setup lang="ts">
import { cn } from '@/lib/utils'
const props = defineProps<{ class?: string; modelValue?: string; placeholder?: string; disabled?: boolean; rows?: number; required?: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()
</script>

<template>
  <textarea
    :value="modelValue"
    :placeholder="placeholder"
    :disabled="disabled"
    :rows="rows ?? 4"
    :required="required"
    :class="cn('flex w-full rounded-md border bg-card px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50', props.class)"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  />
</template>
