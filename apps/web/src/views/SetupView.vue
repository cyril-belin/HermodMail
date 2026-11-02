<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/lib/api'
import { useSessionStore } from '@/stores/session'
import { t, errorMessage } from '@/lib/i18n'
import Button from '@/components/ui/Button.vue'
import Input from '@/components/ui/Input.vue'
import Label from '@/components/ui/Label.vue'
import Card from '@/components/ui/Card.vue'
import { Mail } from 'lucide-vue-next'

const session = useSessionStore()
const router = useRouter()
const email = ref('')
const displayName = ref('')
const password = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  if (password.value !== confirm.value) {
    error.value = t('setup.mismatch')
    return
  }
  busy.value = true
  try {
    await api.post('/api/setup', { email: email.value, password: password.value, displayName: displayName.value || undefined })
    await session.fetchMe()
    session.needsSetup = false
    router.push('/')
  } catch (err) {
    error.value = errorMessage(err) || t('error.setup_failed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-4">
    <Card class="w-full max-w-md p-8">
      <div class="mb-6 flex items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Mail class="h-5 w-5" /></div>
        <div>
          <h1 class="text-xl font-semibold">{{ t('setup.welcome') }}</h1>
          <p class="text-sm text-muted-foreground">{{ t('setup.subtitle') }}</p>
        </div>
      </div>
      <form class="space-y-4" @submit.prevent="submit">
        <div class="space-y-1.5">
          <Label for="email">{{ t('login.email') }}</Label>
          <Input id="email" v-model="email" type="email" required placeholder="you@example.com" />
        </div>
        <div class="space-y-1.5">
          <Label for="name">{{ t('setup.display_name') }}</Label>
          <Input id="name" v-model="displayName" placeholder="Ada Lovelace" />
        </div>
        <div class="space-y-1.5">
          <Label for="password">{{ t('setup.password_hint') }}</Label>
          <Input id="password" v-model="password" type="password" required minlength="8" />
        </div>
        <div class="space-y-1.5">
          <Label for="confirm">{{ t('setup.confirm') }}</Label>
          <Input id="confirm" v-model="confirm" type="password" required />
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <Button type="submit" class="w-full" :disabled="busy">{{ busy ? t('setup.creating') : t('setup.create') }}</Button>
      </form>
    </Card>
  </div>
</template>
