import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative, so the built app works from any path — a project page, a preview
  // URL, or a file:// open — without being rebuilt for each.
  base: './',
  build: { outDir: 'dist', sourcemap: true },
})
