create extension if not exists pgcrypto;

-- Cuenta publica asociada a Supabase Auth. La app muestra username, nunca el email tecnico.
create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9_-]{2,19}$'),
  created_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

drop policy if exists "Users can read own profile" on public.user_profiles;
create policy "Users can read own profile"
on public.user_profiles for select
to authenticated
using (id = auth.uid());

-- Crea el perfil automaticamente al registrar un usuario.
create or replace function public.handle_new_fittrack_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.user_profiles (id, username)
  values (new.id, lower(trim(new.raw_user_meta_data ->> 'username')));
  return new;
end;
$$;

drop trigger if exists on_fittrack_user_created on auth.users;
create trigger on_fittrack_user_created
after insert on auth.users
for each row execute procedure public.handle_new_fittrack_user();

-- Estado sincronizado de la aplicacion. Mantiene perfil nutricional, comidas,
-- pesajes y comidas frecuentes en un unico documento por usuario.
create table if not exists public.user_app_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{"profile":null,"meals":[],"weighIns":[],"frequentMeals":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_app_states enable row level security;

drop policy if exists "Users can read own app state" on public.user_app_states;
create policy "Users can read own app state"
on public.user_app_states for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can insert own app state" on public.user_app_states;
create policy "Users can insert own app state"
on public.user_app_states for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Users can update own app state" on public.user_app_states;
create policy "Users can update own app state"
on public.user_app_states for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- Tabla historica del MVP. Queda protegida por usuario aunque el estado nuevo
-- se sincroniza mediante user_app_states.
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

alter table public.meals add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.meals enable row level security;

drop policy if exists "Allow anonymous inserts for MVP" on public.meals;
drop policy if exists "Users can manage own meals" on public.meals;
create policy "Users can manage own meals"
on public.meals for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

-- La cuota de IA ahora se contabiliza por cuenta, no por un id manipulable del dispositivo.
create table if not exists public.daily_user_ai_usage (
  usage_date date not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (usage_date, user_id)
);

alter table public.daily_user_ai_usage enable row level security;

create table if not exists public.photo_analyses (
  id uuid primary key default gen_random_uuid(),
  device_id text,
  meal_name text,
  protein numeric,
  carbs numeric,
  fats numeric,
  calories numeric,
  status text not null,
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.photo_analyses add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.photo_analyses alter column device_id drop not null;
alter table public.photo_analyses enable row level security;

grant select on public.user_profiles to authenticated;
grant select, insert, update on public.user_app_states to authenticated;
grant select, insert, update, delete on public.meals to authenticated;
