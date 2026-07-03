-- Core tables referenced by the app + Edge Functions that were created out-of-band (via MCP)
-- and never committed as migrations: `fundamentals`, `transactions`, `corporate_actions`,
-- plus columns the app expects on `watchlist` and `prices`.
-- Everything here is guarded (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) so it is a safe no-op
-- on the production DB and makes a fresh Supabase project (per the README setup) fully functional.

create extension if not exists pgcrypto;

-- ── Fundamentals cache ──────────────────────────────────────────────────────
-- Shared, per-ticker cache written only by the refresh-fundamentals Edge Function (service role);
-- read by any authenticated user. Margins / returns / growth are stored as percentages.
create table if not exists public.fundamentals (
  ticker text primary key,
  beta numeric,
  roic numeric,
  opm numeric,
  gm numeric,
  netm numeric,
  pe numeric,
  peg numeric,
  ps numeric,
  de numeric,
  fcf_yield numeric,
  rev_growth numeric,
  ret1y numeric,
  mom numeric,                 -- 12-1 month momentum
  vol numeric,                 -- annualised volatility
  dd numeric,                  -- max drawdown
  market_cap numeric,
  sector text,
  price_src text,              -- Massive / Yahoo / Finnhub (source of the risk metrics)
  updated_at timestamptz default now()
);
alter table public.fundamentals enable row level security;
drop policy if exists "read fundamentals" on public.fundamentals;
create policy "read fundamentals" on public.fundamentals for select using (auth.role() = 'authenticated');

-- ── Transactions ledger ─────────────────────────────────────────────────────
-- Per-user broker trade ledger (imported from DeGiro out-of-band). Read-only in the app; the
-- Portfolio reconcile + realized-P/L features rebuild positions from these rows.
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  ticker text,
  name text,
  isin text,
  exchange text,
  action text not null,        -- BUY / SELL / …
  quantity numeric not null default 0,
  price numeric not null default 0,
  currency text not null default 'EUR',
  value_eur numeric,
  fx numeric,
  fees_eur numeric,
  total_eur numeric,           -- negative = cash out (a buy)
  order_id text,
  source text,                 -- DeGiro / ServiceNow / …
  cost_basis numeric,
  proceeds numeric,
  gain_loss numeric,
  created_at timestamptz default now()
);
alter table public.transactions enable row level security;
create index if not exists transactions_user_date_idx on public.transactions (user_id, date desc);

-- ── Corporate actions ───────────────────────────────────────────────────────
-- Per-user registry of splits/migrations that reconcile applies to the ledger.
create table if not exists public.corporate_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  effective_date date not null,
  type text not null default 'split',   -- split / reverse_split / other
  ratio numeric not null,               -- new shares per old (5 = 5:1; 0.5 = 1-for-2 reverse)
  broker_handled boolean default false, -- true = already in the broker feed; NOT re-applied
  note text,
  created_at timestamptz default now()
);
alter table public.corporate_actions enable row level security;

-- Per-user "own rows" policies for the new tables (mirrors the loop in 0001_init.sql).
do $$
declare t text;
begin
  foreach t in array array['transactions','corporate_actions'] loop
    execute format('drop policy if exists "own rows" on public.%I;', t);
    execute format('create policy "own rows" on public.%I for all using (user_id = auth.uid()) with check (user_id = auth.uid());', t);
  end loop;
end $$;

-- ── Column back-fills the app/Edge Functions expect ─────────────────────────
-- watchlist: structured "why I'm watching" + per-bucket tag + recompute-buy-targets output.
alter table public.watchlist
  add column if not exists bucket text,
  add column if not exists reasons text[],
  add column if not exists target_note text,
  add column if not exists target_set_at timestamptz;

-- prices: today's % change + previous close (written by refresh-prices).
alter table public.prices
  add column if not exists change_pct numeric,
  add column if not exists prev_close numeric;
