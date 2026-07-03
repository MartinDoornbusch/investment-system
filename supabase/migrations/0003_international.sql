-- International screener support: region-partitioned universe with scanner-sourced fields.
-- region defaults to 'us' so all existing rows and queries keep working unchanged.
-- Applied to production 2026-07-02 via MCP (migration: universe_cache_international_columns).

-- Shared candidate-universe cache (S&P 1500 + intl). Written only by the refresh-universe(-intl)
-- Edge Functions via the service role; read by any authenticated user (Screener freshness badge,
-- and the `screen` function which uses the service role). The international columns are added by
-- the ALTER below. Guarded with IF NOT EXISTS so this is a no-op on the production DB where the
-- table already exists (it was created out-of-band via MCP before these migrations were committed).
create table if not exists public.universe_cache (
  ticker text primary key,
  source text,                 -- sp500 / sp400 / sp600 / tv-europe …
  name text,
  sector text,
  exchange text,
  market_cap numeric,
  cap_band text,               -- large / mid / small
  beta numeric,
  pe numeric,
  ps numeric,
  roe numeric,
  roic numeric,
  opm numeric,
  netm numeric,
  gm numeric,
  div_yield numeric,
  rev_growth numeric,
  ret1y numeric,
  fcf_yield numeric,
  avg_dollar_vol numeric,      -- average daily dollar volume (liquidity)
  updated_at timestamptz default now()
);
alter table public.universe_cache enable row level security;
drop policy if exists "read universe_cache" on public.universe_cache;
create policy "read universe_cache" on public.universe_cache for select using (auth.role() = 'authenticated');

ALTER TABLE public.universe_cache
  ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'us',
  ADD COLUMN IF NOT EXISTS ev_ebitda numeric,
  ADD COLUMN IF NOT EXISTS pb numeric,
  ADD COLUMN IF NOT EXISTS de numeric,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS tv_symbol text;
CREATE INDEX IF NOT EXISTS universe_cache_region_idx ON public.universe_cache (region);
