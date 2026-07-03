import { NavLink, Route, Routes, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './auth'
import { supabase, supabaseConfigured, passkeySupported } from './lib/supabase'
import { useState, useEffect } from 'react'
import Dashboard from './pages/Dashboard'
import Portfolio from './pages/Portfolio'
import Scoring from './pages/Scoring'
import Journal from './pages/Journal'
import Watchlist from './pages/Watchlist'
import Screener from './pages/Screener'
import Transactions from './pages/Transactions'
import Rules from './pages/Rules'
import { cls } from './lib/format'
import { MarketStrip } from './components/MarketStrip'

// ── SVG icon set ────────────────────────────────────────────────────────────
const Icons: Record<string, JSX.Element> = {
  dashboard: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  ),
  portfolio: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>
    </svg>
  ),
  score: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
    </svg>
  ),
  watchlist: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  ),
  transactions: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
    </svg>
  ),
  journal: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
    </svg>
  ),
  rules: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
      <line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/>
      <line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
    </svg>
  ),
  signout: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  ),
  chart: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  ),
  screener: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  ),
  more: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
  ),
}

// Mobile bottom-bar tabs (the rest live behind "More").
const MOBILE_PRIMARY = ['/', '/portfolio', '/watchlist', '/screener']

const NAV = [
  { to: '/', label: 'Dashboard',    icon: 'dashboard'    },
  { to: '/portfolio', label: 'Portfolio',   icon: 'portfolio'   },
  { to: '/screener',  label: 'Screener',    icon: 'screener'    },
  { to: '/watchlist', label: 'Watchlist',   icon: 'watchlist'   },
  { to: '/score',     label: 'Score',       icon: 'score'       },
  { to: '/transactions', label: 'Transactions', icon: 'transactions' },
  { to: '/journal',   label: 'Journal',     icon: 'journal'     },
  { to: '/rules',     label: 'Rules',       icon: 'rules'       },
]

function ConfigNotice() {
  return (
    <div className="max-w-lg mx-auto mt-16 card">
      <h1 className="text-lg font-bold text-navy mb-2">Setup needed</h1>
      <p className="text-sm text-dim">Set <code className="text-brandblue">VITE_SUPABASE_URL</code> and <code className="text-brandblue">VITE_SUPABASE_ANON_KEY</code> (in <code>.env</code> locally, or as GitHub Actions secrets) and rebuild.</p>
    </div>
  )
}

function Login() {
  const { signIn, signInPasskey } = useAuth()
  const [email, setEmail] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="min-h-screen bg-[#0d1117] flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo mark */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className="w-9 h-9 rounded-xl bg-[#1f6feb] flex items-center justify-center text-white">
            {Icons.chart}
          </div>
          <span className="text-xl font-bold text-[#e6edf3]">InvSys</span>
        </div>

        <div className="card space-y-4">
          <div>
            <h1 className="text-lg font-semibold text-[#e6edf3]">Sign in</h1>
            <p className="text-sm text-dim mt-0.5">Access your investment dashboard.</p>
          </div>

          {passkeySupported && (
            <>
              <button
                className="btn-primary w-full"
                disabled={busy}
                onClick={async () => { setBusy(true); const r = await signInPasskey(); setBusy(false); if (r) setMsg(r) }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
                </svg>
                Sign in with passkey / Face ID
              </button>
              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-border" />
                <span className="text-[11px] text-dim">or magic link</span>
                <div className="flex-1 h-px bg-border" />
              </div>
            </>
          )}

          <input
            className="input"
            type="email"
            placeholder="you@email.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
          />
          <button
            className="btn-ghost border border-border w-full"
            onClick={async () => setMsg(await signIn(email))}
          >
            Send magic link
          </button>
          {msg && <p className="text-sm text-dim">{msg}</p>}
        </div>
      </div>
    </div>
  )
}

function PasskeySetup() {
  const { registerPasskey } = useAuth()
  const [count, setCount] = useState<number | null>(null)
  const [msg, setMsg] = useState('')
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    let live = true
    ;(async () => {
      try { const { data } = await (supabase.auth as any).passkey.list(); if (live) setCount(Array.isArray(data) ? data.length : 0) }
      catch { if (live) setCount(0) }
    })()
    return () => { live = false }
  }, [msg])
  if (!passkeySupported || dismissed || count === null || count > 0) return null
  return (
    <div className="card mb-4 border-[#1f6feb] bg-[#0d1f35]">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm text-[#e6edf3]">Set up <b>passkey / Face ID</b> for faster sign-in on this device.</div>
        <div className="flex gap-2 shrink-0">
          <button className="btn-primary" onClick={async () => setMsg(await registerPasskey())}>Set up</button>
          <button className="btn-ghost" onClick={() => setDismissed(true)}>Later</button>
        </div>
      </div>
      {msg && <p className="text-xs text-dim mt-2">{msg}</p>}
    </div>
  )
}

export default function App() {
  const { session, loading, signOut } = useAuth()
  const [moreOpen, setMoreOpen] = useState(false)
  const [deskMore, setDeskMore] = useState(false)
  const loc = useLocation()
  const tabCls = (isActive: boolean, extra = '') => cls(
    'flex items-center gap-1.5 px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors',
    isActive ? 'border-brandblue text-brandblue font-medium' : 'border-transparent text-dim hover:text-[#e6edf3]',
    extra)
  const secondaryActive = NAV.some(n => !MOBILE_PRIMARY.includes(n.to) && n.to === loc.pathname)
  if (!supabaseConfigured) return <ConfigNotice />
  if (loading) return (
    <div className="min-h-screen bg-[#0d1117] flex items-center justify-center">
      <div className="text-dim text-sm">Loading…</div>
    </div>
  )
  if (!session) return <Login />

  return (
    <div className="min-h-screen pb-20 md:pb-0">

      {/* Top header: brand · market strip · section tabs */}
      <header className="sticky top-0 z-30 bg-[#010409] border-b border-border">
        <div className="max-w-7xl mx-auto px-4 md:px-6">
          {/* Row 1: brand + market strip + sign out */}
          <div className="flex items-center gap-3 py-2.5">
            <div className="flex items-center gap-2 shrink-0">
              <div className="w-7 h-7 rounded-lg bg-[#1f6feb] flex items-center justify-center text-white">{Icons.chart}</div>
              <span className="font-semibold text-[#e6edf3] text-sm">InvSys</span>
            </div>
            <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar"><MarketStrip compact /></div>
            <button className="text-sm text-dim hover:text-[#e6edf3] transition-colors shrink-0" onClick={signOut}>Sign out</button>
          </div>
          {/* Row 2: section tabs (desktop) */}
          <nav className="hidden md:flex items-center gap-1">
            {/* Primary tabs — always visible on desktop */}
            {NAV.filter(n => MOBILE_PRIMARY.includes(n.to)).map(n => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'} onClick={() => setDeskMore(false)}
                className={({ isActive }) => tabCls(isActive)}>
                <span className="opacity-80">{Icons[n.icon]}</span>{n.label}
              </NavLink>
            ))}
            {/* Secondary tabs — inline only on wide (lg+) screens */}
            {NAV.filter(n => !MOBILE_PRIMARY.includes(n.to)).map(n => (
              <NavLink key={n.to} to={n.to} onClick={() => setDeskMore(false)}
                className={({ isActive }) => tabCls(isActive, 'hidden lg:flex')}>
                <span className="opacity-80">{Icons[n.icon]}</span>{n.label}
              </NavLink>
            ))}
            {/* More dropdown — medium screens only; holds the secondary tabs */}
            <div className="relative lg:hidden">
              <button onClick={() => setDeskMore(o => !o)}
                className={cls('flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
                  deskMore || secondaryActive ? 'border-brandblue text-brandblue font-medium' : 'border-transparent text-dim hover:text-[#e6edf3]')}>
                <span className="opacity-80">{Icons.more}</span>More
              </button>
              {deskMore && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setDeskMore(false)} />
                  <div className="absolute right-0 top-full mt-1 z-30 bg-[#010409] border border-border rounded-lg p-1 min-w-[170px] shadow-2xl">
                    {NAV.filter(n => !MOBILE_PRIMARY.includes(n.to)).map(n => (
                      <NavLink key={n.to} to={n.to} onClick={() => setDeskMore(false)}
                        className={({ isActive }) => cls('flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors',
                          isActive ? 'bg-[#1f3a5f] text-brandblue font-medium' : 'text-dim hover:bg-surface-2 hover:text-[#e6edf3]')}>
                        <span className="shrink-0 opacity-80">{Icons[n.icon]}</span>{n.label}
                      </NavLink>
                    ))}
                  </div>
                </>
              )}
            </div>
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-6">
        <PasskeySetup />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/score" element={<Scoring />} />
          <Route path="/screener" element={<Screener />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/journal" element={<Journal />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>

      {/* More sheet (mobile) */}
      {moreOpen && (
        <>
          <div className="md:hidden fixed inset-0 z-20 bg-black/50" onClick={() => setMoreOpen(false)} />
          <div className="md:hidden fixed bottom-14 inset-x-0 z-30 bg-[#010409] border-t border-border p-2 grid grid-cols-2 gap-1">
            {NAV.filter(n => !MOBILE_PRIMARY.includes(n.to)).map(n => (
              <NavLink key={n.to} to={n.to} onClick={() => setMoreOpen(false)}
                className={({ isActive }) => cls(
                  'flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors',
                  isActive ? 'bg-[#1f3a5f] text-brandblue font-medium' : 'text-dim hover:bg-surface-2 hover:text-[#e6edf3]'
                )}>
                <span className="shrink-0 opacity-80">{Icons[n.icon]}</span>{n.label}
              </NavLink>
            ))}
            <button onClick={() => { setMoreOpen(false); signOut() }}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-dim hover:bg-surface-2 hover:text-[#e6edf3]">
              <span className="shrink-0">{Icons.signout}</span>Sign out
            </button>
          </div>
        </>
      )}

      {/* Bottom tab bar (mobile) */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-[#010409] border-t border-border flex justify-around z-30">
        {NAV.filter(n => MOBILE_PRIMARY.includes(n.to)).map(n => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            onClick={() => setMoreOpen(false)}
            className={({ isActive }) => cls(
              'flex flex-col items-center py-2 px-1 text-[10px] gap-0.5 transition-colors',
              isActive ? 'text-brandblue font-semibold' : 'text-dim'
            )}
          >
            <span>{Icons[n.icon]}</span>
            {n.label}
          </NavLink>
        ))}
        <button
          onClick={() => setMoreOpen(o => !o)}
          className={cls(
            'flex flex-col items-center py-2 px-1 text-[10px] gap-0.5 transition-colors',
            moreOpen || NAV.some(n => !MOBILE_PRIMARY.includes(n.to) && n.to === loc.pathname) ? 'text-brandblue font-semibold' : 'text-dim'
          )}
        >
          <span>{Icons.more}</span>
          More
        </button>
      </nav>
    </div>
  )
}
