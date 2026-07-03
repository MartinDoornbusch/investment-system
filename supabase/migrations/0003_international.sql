-- International screener support: region-partitioned universe with scanner-sourced fields.
-- region defaults to 'us' so all existing rows and queries keep working unchanged.
-- Applied to production 2026-07-02 via MCP (migration: universe_cache_international_columns).
ALTER TABLE public.universe_cache
  ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'us',
  ADD COLUMN IF NOT EXISTS ev_ebitda numeric,
  ADD COLUMN IF NOT EXISTS pb numeric,
  ADD COLUMN IF NOT EXISTS de numeric,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS tv_symbol text;
CREATE INDEX IF NOT EXISTS universe_cache_region_idx ON public.universe_cache (region);
