// Web Push (PWA notifications) — client side. The public VAPID key is a build-time env var
// (VITE_VAPID_PUBLIC_KEY); the matching private key lives only in the send-alerts Edge Function.
import { supabase } from './supabase'

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
export const pushConfigured = !!VAPID_PUBLIC &&
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
  typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window

export type PushState = 'unsupported' | 'unconfigured' | 'denied' | 'subscribed' | 'unsubscribed'

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

export async function getPushState(): Promise<PushState> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  if (!VAPID_PUBLIC) return 'unconfigured'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  return sub ? 'subscribed' : 'unsubscribed'
}

export async function enablePush(): Promise<string> {
  if (!pushConfigured) return 'Push notifications are not available on this device/browser.'
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return 'Permission was not granted.'
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC!) as BufferSource })
  const json = sub.toJSON()
  const keys = json.keys
  if (!keys?.p256dh || !keys?.auth) return 'Could not read the push subscription keys.'
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return 'Not signed in.'
  const { error } = await supabase.from('push_subscriptions').upsert(
    { user_id: user.id, endpoint: sub.endpoint, p256dh: keys.p256dh, auth: keys.auth, user_agent: navigator.userAgent },
    { onConflict: 'endpoint' },
  )
  return error ? `Failed to save subscription: ${error.message}` : 'Notifications enabled on this device.'
}

export async function disablePush(): Promise<string> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return ''
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (sub) {
    await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
    await sub.unsubscribe()
  }
  return 'Notifications disabled on this device.'
}
