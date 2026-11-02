<script setup lang="ts">
import { computed } from 'vue'
import { Check } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

const props = defineProps<{ modelValue?: boolean; class?: string; id?: string; disabled?: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()
const checked = computed(() => props.modelValue ?? false)
</script>

<template>
  <button
    :id="id"
    type="button"
    role="checkbox"
    :aria-checked="checked"
    :disabled="disabled"
    :class="cn('peer h-4 w-4 shrink-0 rounded-sm border shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer disabled:opacity-50', checked ? 'bg-primary text-primary-foreground border-primary' : 'bg-card', props.class)"
    @click="emit('update:modelValue', !checked)"
  >
    <Check v-if="checked" class="h-3 w-3" />
  </button>
</template>
