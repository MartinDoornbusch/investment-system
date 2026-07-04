import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      // @supabase/phoenix ships a broken exports map (phoenix.mjs is missing).
      // Point directly to the CJS build which does exist.
      '@supabase/phoenix': new URL('./node_modules/@supabase/phoenix/priv/static/phoenix.cjs.js', import.meta.url).pathname,
    },
  },
  optimizeDeps: {
    exclude: ['@supabase/realtime-js'],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon-192.png', 'icon-512.png'],
      // Pull the Web Push handlers into the generated service worker.
      workbox: { importScripts: ['push-sw.js'] },
      manifest: {
        name: 'Investment System',
        short_name: 'InvSys',
        description: 'Personal rules-based investment system',
        theme_color: '#1f4e78',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ]
})
