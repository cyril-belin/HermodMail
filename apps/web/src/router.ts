import { createRouter, createWebHistory } from 'vue-router'
import { useSessionStore } from '@/stores/session'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/setup', component: () => import('@/views/SetupView.vue'), meta: { public: true, setupOnly: true } },
    { path: '/login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
    { path: '/', component: () => import('@/views/MailView.vue') },
    { path: '/settings', component: () => import('@/views/SettingsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  const session = useSessionStore()
  if (to.meta.setupOnly) return true
  if (!session.loaded) await session.fetchMe()
  if (session.needsSetup === null) await session.checkSetup()
  if (session.needsSetup) return { path: '/setup' }
  if (!to.meta.public && !session.user) return { path: '/login' }
  if (to.path === '/login' && session.user) return { path: '/' }
  return true
})
