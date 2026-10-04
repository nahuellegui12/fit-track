create extension if not exists pgcrypto;

create table if not exists public.meals (
  id text primary key,
  name text not null,
  meal_type text not null,
  protein numeric not null,
  carbs numeric not null,
  fats numeric not null,
  calories numeric not null,
  created_at timestamptz not null default now()
);

alter table public.meals enable row level security;

create policy "Allow anonymous inserts for MVP"
on public.meals
for insert
to anon
with check (true);

create table if not exists public.daily_ai_usage (
  usage_date date not null,
  device_id text not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (usage_date, device_id)
);

create table if not exists public.photo_analyses (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  meal_name text,
  protein numeric,
  carbs numeric,
  fats numeric,
  calories numeric,
  status text not null,
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.daily_ai_usage enable row level security;
alter table public.photo_analyses enable row level security;
