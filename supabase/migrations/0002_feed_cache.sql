-- Per-user cache for dashboard feeds (earnings, ipo) so the free FMP/Massive quotas aren't
-- burned by repeated dashboard loads. market-feed reads (TTL 6h earnings / 12h ipo) and upserts.
create table if not exists public.feed_cache (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, kind)
);
alter table public.feed_cache enable row level security;
drop policy if exists "own feed_cache" on public.feed_cache;
create policy "own feed_cache" on public.feed_cache for all using (user_id = auth.uid()) with check (user_id = auth.uid());
