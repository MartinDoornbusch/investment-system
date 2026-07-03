import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supabaseConfigured = Boolean(url && anon)
// Fallbacks keep the app from crashing before env is set (shows a config notice instead).
// experimental.passkey opts into WebAuthn/passkey auth (Face ID / Touch ID). Requires
// @supabase/supabase-js >= 2.105 and Passkeys enabled in the project dashboard.
export const supabase = createClient(url || 'https://placeholder.supabase.co', anon || 'placeholder', {
  auth: { persistSession: true, autoRefreshToken: true, experimental: { passkey: true } },
} as any)

// True when the browser supports WebAuthn (passkeys). iOS Safari / installed PWA = yes.
export const passkeySupported = typeof window !== 'undefined' && !!window.PublicKeyCredential
