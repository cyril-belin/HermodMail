<script setup lang="ts">
import { cn } from '@/lib/utils'
import { computed } from 'vue'

const props = withDefaults(defineProps<{ class?: string; variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' }>(), { variant: 'default' })
const classes = computed(() =>
  cn(
    'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
    {
      default: 'bg-primary/15 text-primary',
      secondary: 'bg-muted text-muted-foreground',
      destructive: 'bg-destructive/15 text-destructive',
      outline: 'border',
      success: 'bg-accent text-accent-foreground',
    }[props.variant],
    props.class,
  ),
)
</script>

<template>
  <span :class="classes"><slot /></span>
</template>
