<script setup lang="ts">
import { DialogRoot, DialogTrigger, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose } from 'reka-ui'
import { X } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{ title?: string; description?: string; class?: string; wide?: boolean }>(), {})
const open = defineModel<boolean>('open', { default: false })
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogTrigger v-if="$slots.trigger" as-child>
      <slot name="trigger" />
    </DialogTrigger>
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-black/50" />
      <DialogContent
        :class="cn('fixed left-1/2 top-1/2 z-50 w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-6 shadow-lg focus:outline-none max-h-[90vh] overflow-y-auto', props.wide ? 'max-w-2xl' : 'max-w-md', props.class)"
      >
        <div v-if="props.title || $slots.title" class="mb-4">
          <DialogTitle class="text-lg font-semibold"><slot name="title">{{ props.title }}</slot></DialogTitle>
          <DialogDescription v-if="props.description || $slots.description" class="mt-1 text-sm text-muted-foreground">
            <slot name="description">{{ props.description }}</slot>
          </DialogDescription>
        </div>
        <slot />
        <DialogClose class="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none cursor-pointer">
          <X class="h-4 w-4" />
        </DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
