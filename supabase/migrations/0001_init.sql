-- Investment System schema + row-level security
-- Run this in the Supabase SQL editor (or via `supabase db push`).

create extension if not exists pgcrypto;

create table if not exists system_config (
  user_id uuid primary key references auth.users(id) on delete cascade,
  config jsonb not null,
  updated_at timestamptz default now()
);

create table if not exists holdings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  name text,
  bucket text not null,
  currency text not null default 'USD',
  shares numeric not null default 0,
  entry_price numeric not null default 0,
  notes text,
  created_at timestamptz default now()
);

create table if not exists scores (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  value int, quality int, momentum int, safety int,
  composite int, verdict text, note text,
  created_at timestamptz default now()
);

create table if not exists watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null, thesis text, target_buy numeric,
  created_at timestamptz default now()
);

create table if not exists journal (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null default current_date,
  action text not null, ticker text not null,
  weight_pct numeric, score int, rule text, rationale text,
  created_at timestamptz default now()
);

-- Shared price cache (written only by the Edge Function via service role)
create table if not exists prices (
  ticker text primary key,
  price numeric not null,
  updated_at timestamptz default now()
);

alter table system_config enable row level security;
alter table holdings enable row level security;
alter table scores enable row level security;
alter table watchlist enable row level security;
alter table journal enable row level security;
alter table prices enable row level security;

-- Per-user policies: a user can only see/modify their own rows.
do $$
declare t text;
begin
  foreach t in array array['system_config','holdings','scores','watchlist','journal'] loop
    execute format('drop policy if exists "own rows" on %I;', t);
    execute format('create policy "own rows" on %I for all using (user_id = auth.uid()) with check (user_id = auth.uid());', t);
  end loop;
end $$;

-- Prices: any authenticated user can read; writes happen via service role (bypasses RLS).
drop policy if exists "read prices" on prices;
create policy "read prices" on prices for select using (auth.role() = 'authenticated');
