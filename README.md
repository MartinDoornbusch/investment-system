# Investment System

A personal, rules-based investing app — installable PWA (works in any browser and on your phone), React + Vite front end, **Supabase** backend (Postgres + magic-link auth + row-level security), live prices from **Financial Modeling Prep**, deployed free on **GitHub Pages**.

Modules: **Dashboard** (totals, allocation vs target, rule-breach alerts) · **Portfolio** (holdings, live prices, weights, drift, concentration flags) · **Score** (rate a stock on Value/Quality/Momentum/Safety → composite + verdict) · **Journal** (watchlist + decision log) · **Rules** (edit your Investment Policy: targets, caps, scoring weights, thresholds).

---

## One-time setup (~15 min)

### 1. Supabase (backend)
1. Create a free project at https://supabase.com → note the **Project URL** and **anon public key** (Settings → API).
2. In **SQL Editor**, paste and run `supabase/migrations/0001_init.sql` (creates tables + row-level security).
3. **Edge Function** for prices (keeps your FMP key server-side). Easiest via the Supabase CLI:
   ```bash
   npm i -g supabase
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase secrets set FMP_API_KEY=<your-fmp-key>
   supabase functions deploy refresh-prices
   ```
4. **Auth → URL Configuration**: add your GitHub Pages URL (below) to *Site URL* and *Redirect URLs* so magic links work. For local dev also add `http://localhost:5173`.

### 2. GitHub (repo + hosting)
1. Create an **empty** repo (no README) named e.g. `investment-system`.
2. Push this folder (commands below).
3. Repo **Settings → Secrets and variables → Actions** → add:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon key
4. Repo **Settings → Pages** → Source = **GitHub Actions**.
5. The included workflow builds and deploys on every push to `main`. Your app: `https://<user>.github.io/<repo>/`.

### 3. Push
```bash
cd investment-system
git init && git add . && git commit -m "Initial investment system"
git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

### 4. First run
Open the Pages URL → sign in with your email (magic link) → **Portfolio → Load my current portfolio** (seeds your holdings) → **Refresh prices**. Tune everything in **Rules**.

---

## Local development
```bash
cp .env.example .env   # fill in your Supabase URL + anon key
npm install
npm run dev
```

## Notes & honest limits
- **Prices:** FMP free tier is rate-limited; the app caches the last fetched prices in the `prices` table and you refresh on demand. If a ticker doesn't update, it likely isn't on your FMP plan (the app falls back to your entry price).
- **The scoring inputs are yours to judge** (Value/Quality/Momentum 0–100). A later version can auto-populate them from FMP fundamentals.
- **Not connected to your broker** — this informs decisions; you execute trades.
- Data is private to your account via row-level security. Don't commit your `.env`.

## Stack
React 18 · Vite 5 · Tailwind · vite-plugin-pwa · Supabase JS · React Router (HashRouter, for clean GitHub Pages routing).
