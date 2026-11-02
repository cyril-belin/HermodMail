// theme.ts must run first: it sets the dark/light class on <html> before the
// first paint, so the app never flashes the wrong palette.
import '@/lib/theme'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { router } from './router'
import './styles.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
