# Esquema de Supabase — Sistema de Alertas

Base de datos central que reemplaza el almacenamiento en memoria del hub (`server/server.js`). El hub lee siempre de acá para servir el dashboard. Para escribir, FileMaker ya tiene su propio patrón probado de pegarle directo a la REST API de Supabase con la secret key (ver `filemaker-scripts.md`) — no hace falta pasar por el hub para eso. Las pantallas de sucursal (el navegador en la TV) nunca hablan directo con Supabase, siempre consultan al hub.

---

## 1. `sucursales`

Catálogo de sucursales — necesario porque tanto los pedidos como las alertas se dirigen a una sucursal específica.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `text` PK | slug corto, ej. `providencia`, `bolivia` |
| `nombre` | `text` | ej. "Sucursal Providencia" |
| `activa` | `boolean` default `true` | para desactivar sin borrar |

---

## 2. `pedidos_retirar`

Cola en vivo, **sin historial**: FileMaker inserta una fila cuando un pedido queda "listo para retirar", y la borra de verdad (`DELETE`) cuando el cliente lo retira. Confirmado con el dueño del proyecto — no hace falta guardar cuándo se retiró, solo que la fila exista o no.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `text` PK | id del pedido en FileMaker (recno o campo de pedido), o `ML-<order_id>` para los que vienen de Mercado Libre |
| `sucursal_id` | `text` FK → `sucursales.id`, nullable | `null` = no se sabe la sucursal (caso "acordar con el comprador" de ML) — solo visible en `/todas`, no en la TV de ninguna sucursal puntual |
| `cliente` | `text` | |
| `detalle` | `text` | descripción del pedido |
| `created_at` | `timestamptz` default `now()` | |

**Query del dashboard:** `select * from pedidos_retirar where sucursal_id = :sucursal order by created_at asc`

**Insert desde FileMaker:** puede ir directo por REST de Supabase (mismo patrón que ya usan en otros scripts, con la secret key) o vía `POST /api/pedidos/retirar` del hub — ver `filemaker-scripts.md`.

**Cierre (retiro):** `DELETE` de la fila — directo a Supabase REST o vía `DELETE /api/pedidos/retirar/:id` del hub.

---

## 3. `pedidos_despachar`

Misma lógica que retirar (cola en vivo, sin historial), con destino y transportista.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `text` PK | id del pedido/despacho en FileMaker |
| `sucursal_id` | `text` FK → `sucursales.id` | sucursal de origen del despacho |
| `destino` | `text` | ej. "Bolivia", "Valparaíso" |
| `detalle` | `text` | |
| `transportista` | `text` nullable | `STARKEN` \| `RAPPI` \| `BLUE` (mayúsculas exactas — ver `server/couriers.js`) |
| `estado_envio` | `text` nullable | estado crudo tal cual lo entrega la API del courier (ej. `EN TRANSITO`, `Retirado`, `LD`) — FileMaker ya lo consulta por su cuenta, acá solo se guarda |
| `created_at` | `timestamptz` default `now()` | |

Insert igual que `pedidos_retirar`. El `delete` ya no pasa solo al emitir la etiqueta — ver nota abajo y `filemaker-scripts.md` §2.

**Widget "Enviados, esperando entrega":** `server/couriers.js` traduce `estado_envio` a 3 baldes (pendiente / en_transito / entregado) por courier. Mientras está en `pendiente`, sale en el widget de despacho de siempre; en `en_transito` se muda al widget nuevo (`GET /api/envios-en-transito`); en `entregado` FileMaker borra la fila (mismo criterio "sin historial" de siempre). Sin `estado_envio` (o transportista no reconocido) se trata como pendiente — es el comportamiento de hoy, no rompe nada si todavía no se actualizó el script de FileMaker.

---

## 4. `ventas_mercadolibre`

Alimentada por el webhook que ya tenés escuchando las 3 cuentas de ML. Un pedido tiene N items — se guardan como `jsonb` en vez de tabla aparte porque no se necesita queryarlos individualmente, solo mostrarlos en el marquee.

| Columna | Tipo | Notas |
|---|---|---|
| `order_id` | `text` PK | id de la orden en MercadoLibre |
| `cuenta_ml` | `text` | cuál de las 3 cuentas |
| `cliente` | `text` | comprador |
| `items` | `jsonb` | array `[{titulo, cantidad, precio_unitario}]` |
| `monto_total` | `numeric` | |
| `shipping_status` | `text` | valor crudo que devuelve la API de ML (`pending`, `handling`, `ready_to_ship`, `shipped`, `delivered`, `cancelled`, etc. — **confirmar valores exactos en la doc de ML**, ver TO-DO) |
| `created_at` | `timestamptz` default `now()` | |
| `shipped_at` | `timestamptz` nullable | se setea cuando `shipping_status` pasa a `shipped` |

**Query del dashboard:** mostrar solo `shipping_status != 'shipped'` (o `shipped_at is null`) — desaparece de la vista al despachar, pero queda en la tabla como historial de ventas.

**Nota importante (TO-DO abajo):** hay que confirmar en la documentación de Mercado Libre si `ready_to_ship` es un valor de `shipping.status` o un booleano/flag separado — el webhook de ML normalmente notifica el **topic** (`orders_v2`, `shipments`) y hay que hacer un GET adicional a la API para traer el detalle del shipping.

---

## 5. `notificaciones_sucursal`

> Nota: en el proyecto de Supabase real ya existe una tabla llamada `alertas`, pero es de **otro proyecto de la empresa** (alertas de stock por SKU) — no tocar. Por eso esta tabla se llama distinto.


Reemplaza el array en memoria del hub. Cubre Discord, Tawk.to, correo, y las notificaciones manuales del edit box de FileMaker. `sucursal_id` nullable = alerta para todas las sucursales (ej. si el bot de Discord no puede distinguir sucursal de origen).

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK default `gen_random_uuid()` | |
| `sucursal_id` | `text` FK → `sucursales.id`, nullable | `null` = broadcast a todas |
| `source` | `text` | `discord` \| `tawk` \| `correo` \| `manual` (FileMaker edit box) |
| `title` | `text` nullable | |
| `text` | `text` | contenido mostrado en la barra roja |
| `priority` | `text` default `'normal'` | `normal` \| `alta` |
| `created_at` | `timestamptz` default `now()` | |
| `acknowledged_at` | `timestamptz` nullable | se setea cuando el operario la borra en la pantalla — es el **acuse de recibo** |
| `acknowledged_by` | `text` nullable | opcional: identificador del dispositivo/operario que la cerró |

**Importante — cambio de comportamiento vs. el mockup actual:** hoy el botón `×`/swipe borra la alerta del array. Con Supabase, "cerrar" pasa a ser un `PATCH` que setea `acknowledged_at` (no un `DELETE`), para que quede registro de que alguien la vio. El dashboard sigue mostrando solo `acknowledged_at is null`.

**Query del dashboard:** `select * from alertas where acknowledged_at is null and (sucursal_id = :sucursal or sucursal_id is null) order by created_at asc`

---

## Notas generales de Supabase

- **RLS (Row Level Security):** Supabase la activa por defecto en tablas nuevas. El hub debe usar la **service role key** (nunca la anon key) para saltarse RLS, porque es un backend confiable, no un cliente público. Ninguna de estas tablas debe ser accesible desde el navegador directamente.
- **Realtime (opcional, evaluar después):** Supabase permite suscripciones en tiempo real por tabla. Podría reemplazar el polling actual del dashboard más adelante, pero **no es prioridad ahora** — el polling cada 4-8s ya funciona y es más simple de debuggear.
- Quién escribe dónde: **FileMaker escribe directo a Supabase REST** (con la secret key, mismo patrón que ya usan en sus otros scripts). El bot de Discord, Tawk y el webhook de ML escriben **a través del hub** (necesitan lógica de normalización/verificación de firma que vive en el código del hub, no tiene sentido duplicarla en cada integración). Las pantallas de sucursal siempre leen del hub, nunca de Supabase directo.
- **Conexión directa por `psql`/Postgres:** el host `db.<ref>.supabase.co` dejó de resolver en algún momento (DNS sin respuesta, no es un problema puntual de red). Para conectar manualmente con `psql`, usar el **pooler** en su lugar: `postgresql://postgres.<ref>:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres` (la región puede variar por proyecto — probar `us-east-1` primero).
