<script setup lang="ts">
import { Loader2 } from 'lucide-vue-next'
defineProps<{ text?: string }>()
</script>

<template>
  <div class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
    <Loader2 class="h-4 w-4 animate-spin" />
    <span v-if="text">{{ text }}</span>
  </div>
</template>
