-- Esquema Supabase — Sistema de Alertas Opine Company
-- Ver supabase-schema.md para el detalle de cada tabla.
-- Ejecutar completo en Supabase → SQL Editor (o vía psql contra el connection string del proyecto).

create table if not exists sucursales (
  id text primary key,
  nombre text not null,
  activa boolean not null default true
);

-- Cola en vivo, sin historial: se borra la fila cuando el pedido se retira.
create table if not exists pedidos_retirar (
  id text primary key,
  sucursal_id text not null references sucursales(id),
  cliente text not null,
  detalle text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_pedidos_retirar_sucursal on pedidos_retirar (sucursal_id);

-- Cola en vivo, sin historial: se borra la fila cuando el pedido se despacha.
create table if not exists pedidos_despachar (
  id text primary key,
  sucursal_id text not null references sucursales(id),
  destino text not null,
  detalle text not null,
  transportista text,
  created_at timestamptz not null default now()
);
create index if not exists idx_pedidos_despachar_sucursal on pedidos_despachar (sucursal_id);

create table if not exists ventas_mercadolibre (
  order_id text primary key,
  cuenta_ml text not null,
  cliente text,
  items jsonb not null default '[]'::jsonb,
  monto_total numeric,
  shipping_status text,
  created_at timestamptz not null default now(),
  shipped_at timestamptz
);
create index if not exists idx_ventas_ml_visibles
  on ventas_mercadolibre (shipping_status);

-- Nombrada "notificaciones_sucursal" (no "alertas") porque ese nombre ya
-- lo usa una tabla existente y no relacionada (alertas de stock por SKU).
create table if not exists notificaciones_sucursal (
  id uuid primary key default gen_random_uuid(),
  sucursal_id text references sucursales(id),
  source text not null check (source in ('discord', 'tawk', 'correo', 'manual')),
  title text,
  text text not null,
  priority text not null default 'normal' check (priority in ('normal', 'alta')),
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by text
);
create index if not exists idx_notificaciones_sucursal_pendientes
  on notificaciones_sucursal (sucursal_id) where acknowledged_at is null;

-- RLS: activado por defecto en proyectos nuevos de Supabase.
-- No se definen policies para acceso público (anon) — el hub debe usar
-- la service role key, que ignora RLS. Si más adelante algo necesita
-- leer con la anon key, hay que agregar policies explícitas acá.
alter table sucursales enable row level security;
alter table pedidos_retirar enable row level security;
alter table pedidos_despachar enable row level security;
alter table ventas_mercadolibre enable row level security;
alter table alertas enable row level security;

-- Seed de las 5 sucursales reales
insert into sucursales (id, nombre) values
  ('providencia', 'Sucursal Providencia'),
  ('renca', 'Sucursal Renca'),
  ('agustinas', 'Sucursal Agustinas'),
  ('lampa', 'Sucursal Lampa'),
  ('nunoa', 'Sucursal Ñuñoa')
on conflict (id) do nothing;

-- Widget "Enviados, esperando entrega" (Starken/Rappi/Blue Express) — ver
-- filemaker-scripts.md §5 y server/couriers.js para el detalle. FileMaker ya
-- consulta cada courier por su cuenta, acá solo se guarda el resultado.
alter table pedidos_despachar add column if not exists estado_envio text;

-- Ventas de ML "acordar con el vendedor" (shipping.id viene null — no hay
-- despacho de ML, hay que coordinar el retiro directo con el comprador) no
-- se pueden asignar a una sucursal concreta, así que sucursal_id pasa a ser
-- opcional: null = solo visible en /todas, no en la TV de una sucursal
-- puntual. Ver server/mercadolibre.js.
alter table pedidos_retirar alter column sucursal_id drop not null;

-- Medio de envío de Mercado Libre (FLEX / MERCADO LIBRE / BLUEXPRESS) —
-- se calcula solo en server/mercadolibre.js a partir de logistic_type y
-- tracking_method del shipment, mismo criterio que ya tenían en FileMaker.
alter table ventas_mercadolibre add column if not exists medio_envio text;

-- sucursal_id siempre en minúscula, sin importar cómo lo mande quien
-- escriba (confirmado: el campo de FileMaker admite mayúscula y minúscula
-- indistintamente). Los IDs de `sucursales` son todos minúscula, así que
-- sin esto un "RENCA" en vez de "renca" rompe la foreign key y el insert
-- se pierde en silencio. Se normaliza acá, en la base, para no depender de
-- que cada script de FileMaker lo escriba bien.
create or replace function normalizar_sucursal_id() returns trigger as $$
begin
  if new.sucursal_id is not null then
    new.sucursal_id := lower(new.sucursal_id);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_normalizar_sucursal_pedidos_retirar on pedidos_retirar;
create trigger trg_normalizar_sucursal_pedidos_retirar
  before insert or update on pedidos_retirar
  for each row execute function normalizar_sucursal_id();

drop trigger if exists trg_normalizar_sucursal_pedidos_despachar on pedidos_despachar;
create trigger trg_normalizar_sucursal_pedidos_despachar
  before insert or update on pedidos_despachar
  for each row execute function normalizar_sucursal_id();

drop trigger if exists trg_normalizar_sucursal_notificaciones on notificaciones_sucursal;
create trigger trg_normalizar_sucursal_notificaciones
  before insert or update on notificaciones_sucursal
  for each row execute function normalizar_sucursal_id();

-- REVERTIDO: se había agregado hora_limite_despacho asumiendo que
-- shipping_option.estimated_delivery_time.pay_before era la hora límite
-- para llevar el paquete al punto de despacho. Confirmado en la doc
-- oficial de ML que ese campo es la fecha límite de PAGO (para métodos de
-- pago diferido), no tiene relación con el despacho. Se deja de escribir
-- desde server/mercadolibre.js; se borra la columna para no dejar un
-- nombre engañoso dando vueltas.
alter table ventas_mercadolibre drop column if exists hora_limite_despacho;
