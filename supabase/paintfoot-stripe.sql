-- PaintFoot.io: catalogo de escudos y auditoria de pagos Stripe.
-- Ejecutar en Supabase SQL Editor DESPUES de:
--   1. paintfoot-sync.sql
--   2. paintfoot-global-multiplayer.sql
--   3. paintfoot-custom-auth.sql
--
-- Este archivo es idempotente: puede ejecutarse nuevamente sin borrar compras.
-- Los importes se almacenan en la unidad minima de la moneda (centavos MXN).
-- Las claves STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET NUNCA van en PostgreSQL.

create extension if not exists pgcrypto;

create table if not exists public.paintfoot_shield_products (
  id text primary key,
  name text not null,
  duration_hours integer not null unique,
  currency text not null default 'mxn',
  unit_amount integer not null,
  stripe_price_id text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint paintfoot_shield_products_id_check
    check (id = ('shield_' || duration_hours::text || 'h')),
  constraint paintfoot_shield_products_duration_check
    check (duration_hours in (1, 6, 12, 24, 36)),
  constraint paintfoot_shield_products_currency_check
    check (currency ~ '^[a-z]{3}$'),
  constraint paintfoot_shield_products_amount_check
    check (unit_amount > 0),
  constraint paintfoot_shield_products_price_id_check
    check (stripe_price_id is null or stripe_price_id ~ '^price_[A-Za-z0-9]+$')
);

comment on table public.paintfoot_shield_products is
  'Catalogo publico de precios de escudos. unit_amount se expresa en centavos.';
comment on column public.paintfoot_shield_products.stripe_price_id is
  'Price ID de Stripe opcional. Si es NULL, el servidor usa price_data con unit_amount.';

-- Conserva cualquier Price ID real que ya se haya configurado.
insert into public.paintfoot_shield_products
  (id, name, duration_hours, currency, unit_amount, active)
values
  ('shield_1h',  'Escudo 1 hora',   1, 'mxn',  1000, true),
  ('shield_6h',  'Escudo 6 horas',  6, 'mxn',  3500, true),
  ('shield_12h', 'Escudo 12 horas', 12, 'mxn', 5900, true),
  ('shield_24h', 'Escudo 24 horas', 24, 'mxn', 9900, true),
  ('shield_36h', 'Escudo 36 horas', 36, 'mxn', 12900, true)
on conflict (id) do update set
  name = excluded.name,
  duration_hours = excluded.duration_hours,
  currency = excluded.currency,
  unit_amount = excluded.unit_amount,
  active = excluded.active,
  updated_at = now();

create table if not exists public.paintfoot_stripe_payments (
  id uuid primary key default gen_random_uuid(),
  checkout_session_id text not null unique,
  payment_intent_id text unique,
  player_id text not null,
  territory_id text,
  product_id text not null references public.paintfoot_shield_products(id),
  duration_hours integer not null,
  currency text not null,
  unit_amount integer not null,
  status text not null default 'pending',
  stripe_mode text not null default 'test',
  purchase_reference text,
  metadata jsonb not null default '{}'::jsonb,
  paid_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint paintfoot_stripe_payments_session_check
    check (checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]+$'),
  constraint paintfoot_stripe_payments_duration_check
    check (duration_hours in (1, 6, 12, 24, 36)),
  constraint paintfoot_stripe_payments_currency_check
    check (currency ~ '^[a-z]{3}$'),
  constraint paintfoot_stripe_payments_amount_check
    check (unit_amount > 0),
  constraint paintfoot_stripe_payments_status_check
    check (status in ('pending', 'paid', 'failed', 'expired', 'refunded')),
  constraint paintfoot_stripe_payments_mode_check
    check (stripe_mode in ('test', 'live'))
);

create index if not exists paintfoot_stripe_payments_player_idx
  on public.paintfoot_stripe_payments(player_id, created_at desc);
create index if not exists paintfoot_stripe_payments_status_idx
  on public.paintfoot_stripe_payments(status, updated_at desc);

-- Inventario persistente. Una compra pagada crea exactamente una unidad por
-- checkout_session_id y permanece disponible hasta que el jugador la active.
create table if not exists public.paintfoot_shield_inventory (
  id uuid primary key default gen_random_uuid(),
  checkout_session_id text not null unique,
  player_id uuid not null references public.paintfoot_users(id) on delete cascade,
  product_id text not null references public.paintfoot_shield_products(id),
  duration_hours integer not null,
  currency text not null,
  unit_amount integer not null,
  stripe_mode text not null default 'test',
  status text not null default 'available',
  territory_id text,
  purchased_at timestamptz not null default now(),
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint paintfoot_shield_inventory_session_check
    check (checkout_session_id ~ '^cs_(test|live)_[A-Za-z0-9]+$'),
  constraint paintfoot_shield_inventory_duration_check
    check (duration_hours in (1, 6, 12, 24, 36)),
  constraint paintfoot_shield_inventory_currency_check
    check (currency ~ '^[a-z]{3}$'),
  constraint paintfoot_shield_inventory_amount_check
    check (unit_amount > 0),
  constraint paintfoot_shield_inventory_mode_check
    check (stripe_mode in ('test', 'live')),
  constraint paintfoot_shield_inventory_status_check
    check (status in ('available', 'activated', 'refunded'))
);

create index if not exists paintfoot_shield_inventory_player_idx
  on public.paintfoot_shield_inventory(player_id, status, purchased_at desc);

create table if not exists public.paintfoot_stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  livemode boolean not null default false,
  processed boolean not null default false,
  payload jsonb not null default '{}'::jsonb,
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists paintfoot_stripe_webhook_pending_idx
  on public.paintfoot_stripe_webhook_events(processed, received_at)
  where processed = false;

create or replace function public.paintfoot_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists paintfoot_shield_products_updated_at
  on public.paintfoot_shield_products;
create trigger paintfoot_shield_products_updated_at
before update on public.paintfoot_shield_products
for each row execute function public.paintfoot_set_updated_at();

drop trigger if exists paintfoot_stripe_payments_updated_at
  on public.paintfoot_stripe_payments;
create trigger paintfoot_stripe_payments_updated_at
before update on public.paintfoot_stripe_payments
for each row execute function public.paintfoot_set_updated_at();

drop trigger if exists paintfoot_shield_inventory_updated_at
  on public.paintfoot_shield_inventory;
create trigger paintfoot_shield_inventory_updated_at
before update on public.paintfoot_shield_inventory
for each row execute function public.paintfoot_set_updated_at();

alter table public.paintfoot_shield_products enable row level security;
alter table public.paintfoot_stripe_payments enable row level security;
alter table public.paintfoot_shield_inventory enable row level security;
alter table public.paintfoot_stripe_webhook_events enable row level security;

-- El catalogo no contiene secretos y la app puede consultarlo.
do $$
begin
  create policy "shield_products_public_read"
    on public.paintfoot_shield_products
    for select
    to anon, authenticated
    using (active = true);
exception when duplicate_object then null;
end $$;

-- Compras y webhooks son exclusivos del servidor con SUPABASE_SECRET_KEY.
-- No se crean politicas para anon/authenticated y se revocan sus permisos.
revoke all on public.paintfoot_shield_products from anon, authenticated;
grant select on public.paintfoot_shield_products to anon, authenticated;
revoke all on public.paintfoot_stripe_payments
  from anon, authenticated;
revoke all on public.paintfoot_shield_inventory
  from anon, authenticated;
revoke all on public.paintfoot_stripe_webhook_events
  from anon, authenticated;
revoke all on function public.paintfoot_set_updated_at()
  from public, anon, authenticated;

grant all on public.paintfoot_shield_products to service_role;
grant all on public.paintfoot_stripe_payments to service_role;
grant all on public.paintfoot_shield_inventory to service_role;
grant all on public.paintfoot_stripe_webhook_events to service_role;

-- Si creas Prices permanentes en Stripe, coloca sus IDs de esta forma:
-- update public.paintfoot_shield_products set stripe_price_id = 'price_...'
-- where id = 'shield_12h';
-- Si stripe_price_id queda en NULL, Checkout usa price_data y el importe de esta tabla.

-- Resultado esperado: cinco filas con precios $10, $35, $59, $99 y $129 MXN.
select
  id,
  duration_hours,
  currency,
  unit_amount,
  unit_amount / 100.0 as price_mxn,
  stripe_price_id,
  active
from public.paintfoot_shield_products
order by duration_hours;
