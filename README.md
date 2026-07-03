# Investment System

A personal, rules-based investing app — installable PWA (works in any browser and on your phone), React + Vite front end, **Supabase** backend (Postgres + magic-link / passkey auth + row-level security), live prices from **Finnhub** and **Yahoo Finance**. The front end is a static build, so it deploys free on any static host (Cloudflare Pages, Vercel, Netlify, …).

Modules:
- **Dashboard** — totals, allocation vs target, rule-breach alerts, market strip.
- **Portfolio** — holdings, live prices, weights, drift, concentration flags, and reconciliation against your transaction ledger.
- **Screener** — scan a cached stock universe (S&P 1500 + European listings), auto-classified into buckets and quick-scored.
- **Watchlist** — structured "why I'm watching" + buy-target alerts.
- **Score** — rate a stock on Value / Quality / Momentum / Safety → composite + verdict (auto-populated from fundamentals, or edit by hand).
- **Transactions** — imported broker trade ledger + corporate-actions (splits) registry + realized P/L.
- **Journal** — decision log.
- **Rules** — edit your Investment Policy: targets, caps, per-bucket scoring weights, thresholds.

---

## One-time setup (~15 min)

### 1. Supabase (backend)
1. Create a free project at https://supabase.com → note the **Project URL** and the **anon / publishable key** (Settings → API). Newer projects show this as a `sb_publishable_…` key; it works as the anon key.
2. In **SQL Editor**, paste and run **every migration in `supabase/migrations/` in order** (`0001_init.sql` → `0004_core_tables.sql`). Each file is idempotent (`IF NOT EXISTS`), so you can paste them one after another in a single query. This creates all tables (holdings, scores, watchlist, journal, prices, transactions, fundamentals, universe_cache, corporate_actions, feed_cache) + row-level security.
3. **Edge Functions** for prices, fundamentals and the screener (they keep your API keys server-side). Via the Supabase CLI:
   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref <your-project-ref>

   # Required: US quotes + fundamentals (free tier, 60 req/min).
   supabase secrets set FINNHUB_API_KEY=<your-finnhub-key>
   # Optional: better risk metrics (volatility / drawdown / 12-1 momentum) for US names.
   supabase secrets set MASSIVE_API_KEY=<your-massive-key>
   # Optional: only if you schedule the refresh functions via cron.
   supabase secrets set CRON_SECRET=<any-random-string>

   # Deploy the functions you use (SUPABASE_URL / SERVICE_ROLE are auto-provided):
   supabase functions deploy refresh-prices refresh-fundamentals \
     refresh-universe refresh-universe-intl screen auto-score ticker-detail \
     market-feed market-indices news-digest ipo-brief recompute-buy-targets
   ```
   > Prices need no key for non-US listings (Yahoo is keyless); `FINNHUB_API_KEY` covers US quotes + fundamentals. `diag` / `diag-fmp` are diagnostics only.
4. **Auth → URL Configuration**: add your deployed app URL (from step 2 below) to *Site URL* and *Redirect URLs* so magic links / passkeys work. For local dev also add `http://localhost:5173`. To use passkeys / Face ID, enable **Passkeys** in the Auth settings.

### 2. Host the front end (any static host)
`npm run build` produces a static `dist/` folder. `base: './'` + HashRouter means it works from any path or domain, so any of the options below serve it — pick one.

Whichever host you use, set these two build-time env vars (Vite inlines them at build; they are public by design):
- `VITE_SUPABASE_URL` = your Project URL
- `VITE_SUPABASE_ANON_KEY` = your anon / publishable key

**Cloudflare Pages (recommended)** — generous free tier, works with a **private** repo, no bandwidth cap:
1. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git** → pick this repo.
2. Framework preset **Vite**, build command `npm run build`, output directory `dist`. Node version comes from the committed `.nvmrc`.
3. Add the two env vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) under **Settings → Environment variables** (Production).
4. Deploy. Every push to `main` rebuilds automatically. No SPA `_redirects` file is needed — the app uses HashRouter, so all routing is client-side.

Other static hosts work the same way (build `npm run build`, output `dist`, set the two env vars in the host dashboard):
- **Vercel / Netlify** — import the repo; both serve a private repo free.
- **GitHub Pages** — possible, but the repo must be **public** on the free plan (private Pages needs Pro/Team), and you'd add your own GitHub Actions build-and-deploy workflow.
- **Local / self-hosted** — `npm run build && npm run preview`, or serve `dist/` from any static file server.

### 3. First run
Open your app URL → sign in with your email (magic link) or a passkey → **Portfolio → Load my current portfolio** (seeds your holdings) → **Refresh prices**. Tune everything in **Rules**.

---

## Local development
```bash
cp .env.example .env   # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install
npm run dev            # http://localhost:5173
npm test               # vitest
```

## Notes & honest limits
- **Prices:** the free Finnhub tier is rate-limited; the app caches the last fetched prices in the `prices` table and you refresh on demand. Non-US listings (`.AS`, `.KS`, …) are priced via keyless Yahoo. If a ticker doesn't update it falls back to your entry price.
- **Scoring:** the four pillars (Value / Quality / Momentum / Safety) are auto-populated from Finnhub fundamentals + price-history risk metrics via the `auto-score` / `screen` functions, but you can always override them by hand. Each bucket uses a different weighting profile (see the **Rules** page).
- **Fundamentals & universe** are cached in the `fundamentals` / `universe_cache` tables by the `refresh-*` functions; run them (or schedule via cron) to keep the Screener fresh.
- **Not connected to your broker** — this informs decisions; you execute trades. The transaction ledger is imported (e.g. from DeGiro), not synced live.
- Data is private to your account via row-level security. Don't commit your `.env`.

## Stack
React 18 · Vite 5 · Tailwind · vite-plugin-pwa · Supabase JS (Postgres + Auth + Edge Functions) · lightweight-charts · React Router (HashRouter, for clean GitHub Pages routing).
