-- PaintFoot.io: respaldo offline-first seguro e idempotente.
-- Ejecutar manualmente en Supabase SQL Editor con una cuenta administradora.
-- No usa ni expone service_role en la aplicación.

create table if not exists public.territories (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  geometry jsonb not null,
  area double precision not null default 0 check (area >= 0),
  player_color text not null default '#208AEF',
  status text not null default 'confirmed',
  payload jsonb not null default '{}'::jsonb,
  local_created_at timestamptz,
  server_created_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.territories add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.territories add column if not exists geometry jsonb;
alter table public.territories add column if not exists area double precision not null default 0;
alter table public.territories add column if not exists player_color text not null default '#208AEF';
alter table public.territories add column if not exists status text not null default 'confirmed';
alter table public.territories add column if not exists payload jsonb not null default '{}'::jsonb;
alter table public.territories add column if not exists local_created_at timestamptz;
alter table public.territories add column if not exists server_created_at timestamptz not null default now();
alter table public.territories add column if not exists created_at timestamptz not null default now();
alter table public.territories add column if not exists updated_at timestamptz not null default now();

create table if not exists public.tracking_sessions (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  clock_anomaly boolean not null default false,
  local_started_at timestamptz,
  local_stopped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tracking_points (
  session_id text not null references public.tracking_sessions(id) on delete cascade,
  sequence integer not null check (sequence >= 0),
  user_id uuid not null references auth.users(id) on delete cascade,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  wall_clock_timestamp bigint not null,
  monotonic_timestamp double precision not null,
  monotonic_source text not null,
  boot_id text not null,
  clock_anomaly boolean not null default false,
  previous_hash text not null default '',
  current_hash text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (session_id, sequence)
);

create table if not exists public.paintfoot_sync_operations (
  operation_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  entity_type text not null,
  entity_id text not null,
  payload_hash text,
  processed_at timestamptz not null default now()
);

create index if not exists territories_user_updated_idx on public.territories(user_id, updated_at desc);
create index if not exists tracking_sessions_user_updated_idx on public.tracking_sessions(user_id, updated_at desc);
create index if not exists tracking_points_user_session_idx on public.tracking_points(user_id, session_id, sequence);
create index if not exists sync_operations_user_processed_idx on public.paintfoot_sync_operations(user_id, processed_at desc);

alter table public.territories enable row level security;
alter table public.tracking_sessions enable row level security;
alter table public.tracking_points enable row level security;
alter table public.paintfoot_sync_operations enable row level security;

do $$ begin
  create policy "territories_select_own" on public.territories for select to authenticated using ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "territories_insert_own" on public.territories for insert to authenticated with check ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "territories_update_own" on public.territories for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "sessions_select_own" on public.tracking_sessions for select to authenticated using ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "sessions_insert_own" on public.tracking_sessions for insert to authenticated with check ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "sessions_update_own" on public.tracking_sessions for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "points_select_own" on public.tracking_points for select to authenticated using ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "points_insert_own" on public.tracking_points for insert to authenticated with check ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "points_update_own" on public.tracking_points for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "operations_select_own" on public.paintfoot_sync_operations for select to authenticated using ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;

create or replace function public.sync_paintfoot_operation(
  p_operation_id text,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_session jsonb;
  v_point jsonb;
  v_existing_owner uuid;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if coalesce(p_operation_id, '') = '' or coalesce(p_entity_id, '') = '' then
    raise exception 'INVALID_OPERATION' using errcode = '22023';
  end if;
  if p_action not in ('CREATE_TERRITORY','UPDATE_TERRITORY','CREATE_SESSION','UPDATE_SESSION','UPLOAD_TRACK','SYNC_STATS') then
    raise exception 'UNSUPPORTED_ACTION' using errcode = '22023';
  end if;

  select user_id into v_existing_owner from public.paintfoot_sync_operations where operation_id = p_operation_id;
  if found then
    if v_existing_owner <> v_user_id then raise exception 'OPERATION_OWNED_BY_OTHER_USER' using errcode = '42501'; end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'entityId', p_entity_id, 'serverTime', extract(epoch from clock_timestamp()) * 1000);
  end if;

  if p_action in ('CREATE_TERRITORY','UPDATE_TERRITORY') then
    -- Los territorios globales no pueden confirmarse mediante una escritura genÃ©rica.
    -- paintfoot-global-multiplayer.sql instala confirm_territory_capture, que
    -- valida sesiÃ³n, perÃ­metro, escudo, conflicto e historial.
    raise exception 'USE_SECURE_CAPTURE_RPC' using errcode = '42501';

  elsif p_action in ('CREATE_SESSION','UPDATE_SESSION','UPLOAD_TRACK') then
    v_session := coalesce(p_payload->'session', p_payload);
    select user_id into v_existing_owner from public.tracking_sessions where id = p_entity_id;
    if found and v_existing_owner <> v_user_id then raise exception 'ENTITY_OWNED_BY_OTHER_USER' using errcode = '42501'; end if;
    insert into public.tracking_sessions
      (id, user_id, payload, status, clock_anomaly, local_started_at, local_stopped_at, updated_at)
    values
      (p_entity_id, v_user_id, v_session, coalesce(v_session->>'status','active'),
       coalesce((p_payload->'integrity'->>'clockAnomaly')::boolean, false),
       case when v_session ? 'startedAt' then to_timestamp((v_session->>'startedAt')::double precision / 1000.0) end,
       case when v_session->>'stoppedAt' is not null then to_timestamp((v_session->>'stoppedAt')::double precision / 1000.0) end,
       now())
    on conflict (id) do update set payload = excluded.payload, status = excluded.status,
      clock_anomaly = excluded.clock_anomaly, local_stopped_at = excluded.local_stopped_at, updated_at = now()
    where public.tracking_sessions.user_id = v_user_id;

    if p_action = 'UPLOAD_TRACK' then
      for v_point in select value from jsonb_array_elements(coalesce(p_payload->'points','[]'::jsonb)) loop
        insert into public.tracking_points
          (session_id, sequence, user_id, latitude, longitude, wall_clock_timestamp,
           monotonic_timestamp, monotonic_source, boot_id, clock_anomaly,
           previous_hash, current_hash, payload)
        values
          (p_entity_id, (v_point->>'sequence')::integer, v_user_id,
           (v_point->>'latitude')::double precision, (v_point->>'longitude')::double precision,
           (v_point->>'wallClockTimestamp')::bigint, (v_point->>'monotonicTimestamp')::double precision,
           coalesce(v_point->>'monotonicSource','js_monotonic_fallback'), coalesce(v_point->>'bootId','legacy'),
           coalesce((v_point->>'clockAnomaly')::boolean,false), coalesce(v_point->>'previousHash',''),
           v_point->>'currentHash', v_point)
        on conflict (session_id, sequence) do update set payload = excluded.payload
        where public.tracking_points.user_id = v_user_id
          and public.tracking_points.current_hash = excluded.current_hash;
      end loop;
    end if;
  end if;

  insert into public.paintfoot_sync_operations(operation_id, user_id, action, entity_type, entity_id)
  values (p_operation_id, v_user_id, p_action, p_entity_type, p_entity_id);
  return jsonb_build_object('ok', true, 'duplicate', false, 'entityId', p_entity_id, 'serverTime', extract(epoch from clock_timestamp()) * 1000);
end;
$$;

create or replace function public.get_paintfoot_snapshot()
returns jsonb language sql security definer set search_path = '' stable
as $$
  select case when auth.uid() is null then null else jsonb_build_object(
    'territories', coalesce((select jsonb_agg(payload order by updated_at) from public.territories where user_id = auth.uid()), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(payload order by updated_at) from public.tracking_sessions where user_id = auth.uid()), '[]'::jsonb),
    'serverTime', extract(epoch from clock_timestamp()) * 1000
  ) end;
$$;

revoke all on function public.sync_paintfoot_operation(text,text,text,text,jsonb) from public, anon;
grant execute on function public.sync_paintfoot_operation(text,text,text,text,jsonb) to authenticated;
revoke all on function public.get_paintfoot_snapshot() from public, anon;
grant execute on function public.get_paintfoot_snapshot() to authenticated;
grant select, insert, update on public.territories, public.tracking_sessions, public.tracking_points to authenticated;

