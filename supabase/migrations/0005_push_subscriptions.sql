-- Web Push subscriptions (one row per browser/device that opted in). Written by the client when a
-- user enables notifications; read by the send-alerts Edge Function (service role) to deliver pushes.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "own rows" on public.push_subscriptions;
create policy "own rows" on public.push_subscriptions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
