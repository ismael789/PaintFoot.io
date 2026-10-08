-- PaintFoot.io custom auth (sin Supabase Auth).
-- Ejecutar en Supabase SQL Editor con permisos de administrador.
-- La clave SUPABASE_SECRET_KEY solo debe vivir en el servidor Node.

create extension if not exists pgcrypto;

create table if not exists public.paintfoot_users (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 60),
  age integer not null check (age between 13 and 120),
  email text not null unique check (email = lower(trim(email))),
  password_hash text not null,
  password_salt text not null,
  coins integer not null default 0 check (coins >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.paintfoot_users
  add column if not exists name text;
alter table public.paintfoot_users
  add column if not exists age integer;

create table if not exists public.paintfoot_sessions (
  token_hash text primary key,
  user_id uuid not null references public.paintfoot_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists paintfoot_sessions_user_idx
  on public.paintfoot_sessions(user_id, expires_at);

alter table public.paintfoot_users enable row level security;
alter table public.paintfoot_sessions enable row level security;

-- No se crean políticas públicas: las cuentas solo se manipulan desde server.js
-- usando SUPABASE_SECRET_KEY. Esto evita exponer hashes o sesiones al móvil.

create table if not exists public.paintfoot_coin_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.paintfoot_users(id) on delete cascade,
  event_key text not null,
  amount integer not null check (amount > 0),
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default now(),
  unique(user_id, event_key)
);

create index if not exists paintfoot_coin_events_user_idx
  on public.paintfoot_coin_events(user_id, created_at desc);

create table if not exists public.paintfoot_coin_shields (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.paintfoot_users(id) on delete cascade,
  duration_hours integer not null check (duration_hours in (1, 6, 12, 24, 36)),
  coins_cost integer not null check (coins_cost > 0),
  purchased_at timestamptz not null default now(),
  activated_at timestamptz,
  expires_at timestamptz
);

create index if not exists paintfoot_coin_shields_user_idx
  on public.paintfoot_coin_shields(user_id, purchased_at desc);

alter table public.paintfoot_coin_events enable row level security;
alter table public.paintfoot_coin_shields enable row level security;

-- Las funciones siguientes son para usarse desde una API segura futura.
-- El cliente móvil no recibe permisos directos sobre estas tablas.

create or replace function public.paintfoot_cleanup_sessions()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.paintfoot_sessions where expires_at <= now();
$$;
