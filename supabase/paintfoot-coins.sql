-- PaintFoot.io: monedas globales, deterministas e idempotentes.
-- Ejecutar en Supabase SQL Editor despues de paintfoot-sync.sql.

create table if not exists public.world_coins (
  id text primary key,
  region_id text not null,
  road_segment_id text not null,
  segment_index integer not null,
  density_version integer not null default 1 check (density_version > 0),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  value integer not null default 1 check (value > 0 and value <= 100),
  status text not null default 'available'
    check (status in ('available', 'collected', 'expired')),
  source text not null default 'osm_road',
  content_hash text not null,
  collected_by uuid references auth.users(id) on delete set null,
  collected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.world_coins
  add column if not exists density_version integer not null default 1;

create index if not exists world_coins_region_status_idx
  on public.world_coins(region_id, status);
create index if not exists world_coins_location_idx
  on public.world_coins(latitude, longitude);

create table if not exists public.paintfoot_coin_balances (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.paintfoot_coin_collection_events (
  operation_id text primary key,
  coin_id text not null references public.world_coins(id),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount integer not null check (amount >= 0),
  awarded boolean not null,
  created_at timestamptz not null default now()
);

create table if not exists public.paintfoot_coin_sync_operations (
  operation_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null check (action in ('COIN_REGION_GENERATED', 'COIN_COLLECTED')),
  entity_id text not null,
  processed_at timestamptz not null default now()
);

alter table public.world_coins enable row level security;
alter table public.paintfoot_coin_balances enable row level security;
alter table public.paintfoot_coin_collection_events enable row level security;
alter table public.paintfoot_coin_sync_operations enable row level security;

do $$ begin
  create policy "global_coins_are_visible" on public.world_coins
    for select to authenticated using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "players_read_own_coin_balance" on public.paintfoot_coin_balances
    for select to authenticated using ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "players_read_own_coin_events" on public.paintfoot_coin_collection_events
    for select to authenticated using ((select auth.uid()) = user_id);
exception when duplicate_object then null; end $$;

revoke insert, update, delete on public.world_coins from anon, authenticated;
revoke all on public.paintfoot_coin_balances from anon, authenticated;
revoke all on public.paintfoot_coin_collection_events from anon, authenticated;
revoke all on public.paintfoot_coin_sync_operations from anon, authenticated;
grant select on public.world_coins to authenticated;
grant select on public.paintfoot_coin_balances to authenticated;
grant select on public.paintfoot_coin_collection_events to authenticated;

create or replace function public.publish_world_coin_region(
  p_operation_id text,
  p_region_id text,
  p_coins jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_coin jsonb;
  v_count integer := 0;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if coalesce(p_operation_id, '') = '' or coalesce(p_region_id, '') = '' then
    raise exception 'INVALID_OPERATION' using errcode = '22023';
  end if;
  if jsonb_typeof(p_coins) <> 'array' or jsonb_array_length(p_coins) > 1000 then
    raise exception 'INVALID_COIN_REGION' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.paintfoot_coin_sync_operations
    where operation_id = p_operation_id and user_id = v_user_id
  ) then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;

  for v_coin in select value from jsonb_array_elements(p_coins) loop
    if coalesce(v_coin->>'regionId', '') <> p_region_id
       or coalesce(v_coin->>'id', '') !~ '^world-coin:'
       or coalesce(v_coin->>'source', '') not in ('osm_road', 'debug_visible_seed') then
      raise exception 'INVALID_COIN' using errcode = '22023';
    end if;
    insert into public.world_coins
      (id, region_id, road_segment_id, segment_index, density_version, latitude, longitude,
       value, source, content_hash)
    values
      (v_coin->>'id', p_region_id, v_coin->>'roadSegmentId',
       (v_coin->>'segmentIndex')::integer,
       coalesce((v_coin->>'densityVersion')::integer, 1),
       (v_coin->>'latitude')::double precision,
       (v_coin->>'longitude')::double precision,
       greatest(1, least(100, (v_coin->>'value')::integer)),
       'osm_road', v_coin->>'hash')
    on conflict (id) do update set
      region_id = excluded.region_id,
      road_segment_id = excluded.road_segment_id,
      segment_index = excluded.segment_index,
      density_version = excluded.density_version,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      value = excluded.value,
      content_hash = excluded.content_hash,
      updated_at = now()
    where public.world_coins.status = 'available';
    v_count := v_count + 1;
  end loop;

  insert into public.paintfoot_coin_sync_operations
    (operation_id, user_id, action, entity_id)
  values (p_operation_id, v_user_id, 'COIN_REGION_GENERATED', p_region_id);
  return jsonb_build_object('ok', true, 'duplicate', false, 'coinCount', v_count);
end;
$$;

create or replace function public.collect_world_coin(
  p_operation_id text,
  p_coin_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_coin public.world_coins%rowtype;
  v_event public.paintfoot_coin_collection_events%rowtype;
  v_awarded boolean := false;
  v_balance bigint := 0;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if coalesce(p_operation_id, '') = '' or coalesce(p_coin_id, '') = '' then
    raise exception 'INVALID_OPERATION' using errcode = '22023';
  end if;

  select * into v_event from public.paintfoot_coin_collection_events
    where operation_id = p_operation_id;
  if found then
    if v_event.user_id <> v_user_id then
      raise exception 'OPERATION_OWNED_BY_OTHER_USER' using errcode = '42501';
    end if;
    select balance into v_balance from public.paintfoot_coin_balances where user_id = v_user_id;
    return jsonb_build_object('ok', true, 'duplicate', true,
      'awarded', v_event.awarded, 'balance', coalesce(v_balance, 0));
  end if;

  select * into v_coin from public.world_coins where id = p_coin_id for update;
  if not found then raise exception 'COIN_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_coin.status = 'available' then
    update public.world_coins set status = 'collected', collected_by = v_user_id,
      collected_at = now(), updated_at = now() where id = p_coin_id;
    insert into public.paintfoot_coin_balances(user_id, balance)
      values(v_user_id, v_coin.value)
      on conflict(user_id) do update set
        balance = public.paintfoot_coin_balances.balance + excluded.balance,
        updated_at = now()
      returning balance into v_balance;
    v_awarded := true;
  else
    select balance into v_balance from public.paintfoot_coin_balances where user_id = v_user_id;
  end if;

  insert into public.paintfoot_coin_collection_events
    (operation_id, coin_id, user_id, amount, awarded)
  values (p_operation_id, p_coin_id, v_user_id,
    case when v_awarded then v_coin.value else 0 end, v_awarded);
  insert into public.paintfoot_coin_sync_operations
    (operation_id, user_id, action, entity_id)
  values (p_operation_id, v_user_id, 'COIN_COLLECTED', p_coin_id)
  on conflict (operation_id) do nothing;

  return jsonb_build_object('ok', true, 'duplicate', false,
    'awarded', v_awarded, 'balance', coalesce(v_balance, 0));
end;
$$;

revoke all on function public.publish_world_coin_region(text,text,jsonb) from public, anon;
revoke all on function public.collect_world_coin(text,text) from public, anon;
grant execute on function public.publish_world_coin_region(text,text,jsonb) to authenticated;
grant execute on function public.collect_world_coin(text,text) to authenticated;

do $$ begin
  alter publication supabase_realtime add table public.world_coins;
exception when duplicate_object then null; end $$;
