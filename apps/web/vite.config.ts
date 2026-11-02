import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  server: {
    port: 5667,
    proxy: {
      '/api': 'http://127.0.0.1:8667',
      '/mcp': 'http://127.0.0.1:8667',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
