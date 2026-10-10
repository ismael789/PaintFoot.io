-- PaintFoot.io: tokens, preferencias e idempotencia de notificaciones push.
-- Ejecutar despues de paintfoot-custom-auth.sql. La app usa solamente la clave publica + RLS.

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.paintfoot_users(id) on delete cascade,
  expo_push_token text not null unique check (expo_push_token ~ '^(Expo|Exponent)PushToken\[[^]]+\]$'),
  device_id text not null,
  platform text not null check (platform in ('android', 'ios')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, device_id)
);

create table if not exists public.notification_preferences (
  user_id uuid primary key references public.paintfoot_users(id) on delete cascade,
  shields boolean not null default true,
  territories boolean not null default true,
  coins boolean not null default true,
  sync boolean not null default true,
  world boolean not null default true,
  payments boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.paintfoot_users(id) on delete cascade,
  event_key text not null,
  category text not null check (category in ('shields','territories','coins','sync','world','payments')),
  title text not null,
  sent_at timestamptz not null default now(),
  unique (user_id, event_key)
);

-- Migracion segura para instalaciones que ya ejecutaron una version anterior.
alter table public.notification_preferences
  add column if not exists payments boolean not null default true;
alter table public.notification_log
  drop constraint if exists notification_log_category_check;
alter table public.notification_log
  add constraint notification_log_category_check
  check (category in ('shields','territories','coins','sync','world','payments'));

create index if not exists push_tokens_user_enabled_idx on public.push_tokens(user_id, enabled);
create index if not exists notification_log_user_sent_idx on public.notification_log(user_id, sent_at desc);

alter table public.push_tokens enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_log enable row level security;

do $$ begin
  create policy "users_manage_own_push_tokens" on public.push_tokens
    for all to authenticated using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "users_manage_own_notification_preferences" on public.notification_preferences
    for all to authenticated using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "users_read_own_notification_log" on public.notification_log
    for select to authenticated using ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "users_insert_own_notification_log" on public.notification_log
    for insert to authenticated with check ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;

grant select, insert, update, delete on public.push_tokens to authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select, insert on public.notification_log to authenticated;
