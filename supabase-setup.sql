-- Run this once in Supabase: left sidebar -> SQL Editor -> New query -> paste -> Run.
-- It creates the two tables Peacho uses and locks each person's data to their own account.

-- Each member's plan. People can read their own row, but only your server can change it
-- (the Stripe webhook uses the secret key), so nobody can give themselves a paid plan.
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier text check (tier in ('starter', 'pro', 'ultra')),
  stripe_customer_id text,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "Read own profile" on public.profiles;
create policy "Read own profile" on public.profiles
  for select using ((select auth.uid()) = user_id);

-- Each person's saved chats and projects.
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  messages jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_updated_idx on public.projects (user_id, updated_at desc);

alter table public.projects enable row level security;

drop policy if exists "Read own projects" on public.projects;
create policy "Read own projects" on public.projects
  for select using ((select auth.uid()) = user_id);

drop policy if exists "Create own projects" on public.projects;
create policy "Create own projects" on public.projects
  for insert with check ((select auth.uid()) = user_id);

drop policy if exists "Update own projects" on public.projects;
create policy "Update own projects" on public.projects
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Delete own projects" on public.projects;
create policy "Delete own projects" on public.projects
  for delete using ((select auth.uid()) = user_id);

-- Daily message counts, used to keep your Claude costs predictable.
-- Only your server (with the secret key) can read or change these.
create table if not exists public.usage (
  user_id uuid not null,
  day date not null default current_date,
  count integer not null default 0,
  primary key (user_id, day)
);

alter table public.usage enable row level security;
-- No policies on purpose: the page can't touch this table at all.

create or replace function public.bump_usage(p_user uuid)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into public.usage (user_id, day, count)
  values (p_user, current_date, 1)
  on conflict (user_id, day) do update set count = public.usage.count + 1
  returning count;
$$;

revoke execute on function public.bump_usage(uuid) from public, anon, authenticated;
