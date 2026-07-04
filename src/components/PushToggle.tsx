import { useEffect, useState } from 'react'
import { getPushState, enablePush, disablePush, type PushState } from '../lib/push'

// Per-device opt-in for push notifications (trailing-stop triggers, buy-target hits, rule breaches).
// A push subscription is bound to this browser + device, so each device enables it separately.
export function PushToggle() {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  useEffect(() => { getPushState().then(setState) }, [])

  if (state === 'unsupported') return null // e.g. desktop browsers without push, or non-secure context

  async function toggle(on: boolean) {
    setBusy(true)
    setMsg(on ? await enablePush() : await disablePush())
    setState(await getPushState())
    setBusy(false)
  }

  const subscribed = state === 'subscribed'
  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="font-semibold text-navy">Notifications</h2>
          <p className="text-sm text-dim mt-0.5">
            Get a daily push on this device when a trailing stop triggers, a watchlist buy-target is hit, or a rule is breached.
          </p>
        </div>
        <div className="shrink-0">
          {state === 'unconfigured'
            ? <span className="text-xs text-dim">Push not configured (set VITE_VAPID_PUBLIC_KEY).</span>
            : state === 'denied'
              ? <span className="text-xs text-amber-400">Blocked — enable notifications for this site in your browser settings.</span>
              : <button className={subscribed ? 'btn-ghost border border-border' : 'btn-primary'} disabled={busy} onClick={() => toggle(!subscribed)}>
                  {busy ? '…' : subscribed ? 'Disable on this device' : 'Enable notifications'}
                </button>}
        </div>
      </div>
      {msg && <p className="text-xs text-dim mt-2">{msg}</p>}
    </div>
  )
}
