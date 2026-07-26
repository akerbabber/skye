import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'ui',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The pipeline needs anvil and a wallet, so it runs in server.ts.
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
})
