import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { supabase, supabaseConfigured } from './lib/supabase'
import type { Session } from '@supabase/supabase-js'

interface Ctx {
  session: Session | null; loading: boolean
  signIn: (email: string) => Promise<string>
  signInPasskey: () => Promise<string>
  registerPasskey: () => Promise<string>
  signOut: () => void
}
const AuthCtx = createContext<Ctx>({ session: null, loading: true, signIn: async () => '', signInPasskey: async () => '', registerPasskey: async () => '', signOut: () => {} })
export const useAuth = () => useContext(AuthCtx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    if (!supabaseConfigured) { setLoading(false); return }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])
  const signIn = async (email: string) => {
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } })
    return error ? error.message : 'Check your email for the magic link.'
  }
  // Passkey (WebAuthn / Face ID). Methods exist on supabase-js >= 2.105 with experimental.passkey.
  const signInPasskey = async (): Promise<string> => {
    try {
      const { error } = await (supabase.auth as any).signInWithPasskey()
      return error ? (error.message || 'Passkey sign-in failed') : ''
    } catch (e: any) { return e?.message || 'Passkey sign-in cancelled' }
  }
  const registerPasskey = async (): Promise<string> => {
    try {
      const { error } = await (supabase.auth as any).registerPasskey()
      return error ? (error.message || 'Could not set up passkey') : 'Face ID / passkey is set up on this device.'
    } catch (e: any) { return e?.message || 'Passkey setup cancelled' }
  }
  const signOut = () => supabase.auth.signOut()
  return <AuthCtx.Provider value={{ session, loading, signIn, signInPasskey, registerPasskey, signOut }}>{children}</AuthCtx.Provider>
}
