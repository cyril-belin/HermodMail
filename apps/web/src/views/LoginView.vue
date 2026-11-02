<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
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
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await session.login(email.value, password.value)
    router.push('/')
  } catch (err) {
    error.value = errorMessage(err) || t('error.login_failed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-4">
    <Card class="w-full max-w-sm p-8">
      <div class="mb-6 flex items-center gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Mail class="h-5 w-5" /></div>
        <h1 class="text-xl font-semibold">HermodMail</h1>
      </div>
      <form class="space-y-4" @submit.prevent="submit">
        <div class="space-y-1.5">
          <Label for="email">{{ t('login.email') }}</Label>
          <Input id="email" v-model="email" type="email" required autofocus />
        </div>
        <div class="space-y-1.5">
          <Label for="password">{{ t('login.password') }}</Label>
          <Input id="password" v-model="password" type="password" required />
        </div>
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <Button type="submit" class="w-full" :disabled="busy">{{ busy ? t('login.signing_in') : t('login.signin') }}</Button>
      </form>
    </Card>
  </div>
</template>
