import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative, so the built app works from any path — a project page, a preview
  // URL, or a file:// open — without being rebuilt for each.
  base: './',
  build: { outDir: 'dist', sourcemap: true },

  // `npm run dev` talks to the AutomaBuild server if one is running, so the
  // History tab shows real runs while the editor still hot-reloads. If nothing
  // is listening the request fails, the app falls back to its bundled sample
  // run, and the indicator says so — which is the same path someone opening
  // the static build gets, and is worth exercising rather than hiding.
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        // Without this, a refused connection is an unhandled error in the dev
        // server rather than a failed fetch the app can recover from.
        configure: (proxy) => {
          proxy.on('error', () => {})
        },
      },
    },
  },
})
