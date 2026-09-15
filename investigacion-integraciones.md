# Investigación — Mercado Libre, Tawk.to, Correo GoDaddy

Resultados de investigar la documentación oficial de cada servicio, para resolver los puntos abiertos del [TODO.md](TODO.md).

---

## 1. Mercado Libre

### Topics de notificación a usar
- **`orders_v2`** — creación y cambios en ventas confirmadas.
- **`shipments`** (aparece también como `marketplace_shipments`) — creación y cambios de envío sobre esas ventas.

Se suscriben ambos en el panel de la app en [Application Manager](https://developers.mercadolibre.com), configurando la URL del webhook.

### El payload del webhook NO trae los datos — es solo un aviso
Esto es lo más importante a tener en cuenta al programar: la notificación que llega es un ping mínimo, no el pedido completo.

```json
{
  "_id": "f9f08571-1f65-4c46-9e0a-c0f43faas1557e",
  "resource": "/orders/2195160686",
  "user_id": 468424240,
  "topic": "orders_v2",
  "application_id": 5503910054141466,
  "attempts": 1,
  "sent": "2019-10-30T16:19:20.129Z",
  "received": "2019-10-30T16:19:20.106Z"
}
```

Hay que hacer un **GET adicional** a `resource` (ej. `GET /orders/2195160686` o `GET /shipments/{id}`) con el access token de la cuenta correspondiente para traer el detalle real (cliente, items, `shipping.status`). Esto confirma que **necesitamos guardar/refrescar el OAuth token de cada una de las 3 cuentas** — no es opcional.

### `ready_to_ship` y el resto de los estados de envío
- **`ready_to_ship`**: Mercado Libre ya generó la etiqueta de despacho y expuso el tracking ID — significa que el pago fue aprobado y la orden está lista para el paso de despacho físico. **Esto es lo que debería hacer aparecer el pedido en el panel "Pedidos a Despachar"**, no en el de ventas.
- **`handling`**: previo a `ready_to_ship`, con sub-estados como `waiting_for_label_generation`.
- **`shipped`**: ya despachado — con esto se marca `shipped_at` y desaparece de la vista de ventas pendientes, según lo que ya definimos.
- **`not_delivered`**: estado final cuando no hubo entrega tras agotar intentos.

### Tabla completa de estados (confirmada por el usuario desde el dev portal logueado)

Estados de nivel superior (`shipping.status`) que puede devolver la API — cada uno tiene sub-estados propios (decenas en algunos casos, ej. `shipped` y `not_delivered`), pero **el dashboard solo necesita mirar el estado de nivel superior**, no el sub-estado:

| Status | Significado | ¿Visible en el dashboard? |
|---|---|---|
| `to_be_agreed` | Envío a coordinar | ✅ visible |
| `pending` | Pendiente (pago, revisión, ruta) | ✅ visible |
| `handling` | En preparación (esperando etiqueta) | ✅ visible |
| `ready_to_ship` | Etiqueta generada, listo para despacho | ✅ visible |
| `not_verified` / `active` / `not_specified` / `stale_ready_to_ship` | Variantes de "todavía no salió" | ✅ visible |
| `shipped` | Ya despachado | ❌ se oculta |
| `delivered` | Entregado | ❌ se oculta |
| `not_delivered` | No se pudo entregar (final) | ❌ se oculta |
| `cancelled` | Cancelado | ❌ se oculta |
| `closed` | Cerrado | ❌ se oculta |
| `error` | Error | ❌ se oculta |
| `stale_shipped` | Envío despachado hace mucho sin update | ❌ se oculta |

**Regla de visibilidad para `ventas_mercadolibre`:** ocultar del dashboard cuando `shipping_status` esté en `('shipped','delivered','not_delivered','cancelled','closed','error','stale_shipped')`. Todo lo demás se sigue mostrando como venta pendiente de despachar.

**Decisión de negocio confirmada:** el dashboard solo muestra órdenes nuevas y pendientes — `cancelled` se oculta directo, igual que `shipped`, sin marca visual especial. La regla de la tabla de arriba queda definitiva.

### Job de reconciliación (además del webhook)
El webhook puede fallar, perderse un evento, o llegar y que el GET de detalle falle transitoriamente — si eso pasa con el evento que marca `shipped`, la orden quedaría visible para siempre aunque ya se haya despachado. Por eso, además del flujo por webhook, el hub corre un **job cada 5 minutos** que:
1. Toma todas las filas de `ventas_mercadolibre` que hoy están visibles (`shipping_status` no está en el set oculto).
2. Para cada una, hace `GET /shipments/{shipping_id}` de nuevo y actualiza `shipping_status` si cambió.
3. Si el nuevo estado cae en el set oculto, listo — desaparece del dashboard en el siguiente refresh.

Es un poller de reconciliación, no el mecanismo principal — el webhook sigue siendo la vía rápida, esto solo cubre los casos que el webhook se pierda.

### Reintentos y tiempo de respuesta
El webhook reintenta en intervalos exponenciales (aprox. cada hora) y descarta las notificaciones no confirmadas después de un tiempo. El endpoint del hub debe **responder 2xx rápido** (aceptar y procesar el GET de detalle de forma asíncrona, no bloquear la respuesta al webhook).

### Cómo encaja con lo que ya tenés
Dijiste que ya tenés un webhook propio escuchando las 3 cuentas — entonces el trabajo que falta es: ese webhook (o el hub) hace el GET de detalle, arma el `jsonb` de items, y hace upsert en `ventas_mercadolibre` con el `shipping_status` actual.

**Flujo confirmado:**
1. Llega el aviso del webhook con `resource` (ej. `/orders/2195160686`) y `user_id` (identifica de cuál de las 3 cuentas es).
2. El hub responde 2xx de inmediato (para no generar reintentos de ML).
3. En background, el hub hace `GET https://api.mercadolibre.com/orders/{id}` con el access token de esa cuenta.
4. Si el order trae `shipping.id`, hace un segundo `GET /shipments/{shipping_id}` para el `status` actual (`ready_to_ship`, `shipped`, etc.).
5. Upsert en `ventas_mercadolibre` (`order_id` como PK) con cliente, items, monto y `shipping_status`.

**Fuentes:**
- [Notifications — Mercado Libre Developers](https://developers.mercadolivre.com.br/en_us/products-receive-notifications)
- [Receive notifications — Global Selling](https://global-selling.mercadolibre.com/devsite/receive-notifications)
- [Shipments — Global Selling](https://global-selling.mercadolibre.com/devsite/manage-shipments)
- [Order status and tracking](https://developers.mercadolibre.com.ar/en_us/me1-order-states)

---

## 1.1 Arquitectura real de ML en Opineco (confirmada, reemplaza los supuestos genéricos de arriba)

Extraído de los 2 scripts reales del sistema (DDR "Obtener Ordenes Webhook y Endpoint" + "Obtener Ordenes Endpoint"). Esto es lo que hay que integrar, no lo genérico de la sección 1.

**Dos caminos complementarios (push + pull de respaldo):**

```
MercadoLibre ──(webhook real)──> Railway (relay externo, guarda en cola)
                                         │
                                         │ GET /meli/webhook/consume (poll)
                                         ▼
                                    FileMaker ──> GET /orders/{id} ──> GET /shipments/{id}
                                                                              │
                                                                    filtra por substatus
                                                                              │
                                                                              ▼
                                                                    guarda si es nuevo
```

No es push real hacia FileMaker — es push ML→Railway, y pull Railway→FileMaker (y de ahí a nuestro hub/Supabase).

**Camino 1 — Consumo del relay:**
`GET https://mlwebhook-production.up.railway.app/meli/webhook/consume` — devuelve un array de notificaciones pendientes y las drena al consumirlas (patrón de cola). Cada entrada: `{ "order_id": "...", "seller_id": 1234567, "ts": "..." }`. Este relay es una pieza propia de Opineco (no es el payload real de ML) — normaliza lo que sea que ML le mande a un endpoint público que Opineco ya tiene corriendo en Railway.

**Camino 2 — Polling de respaldo (sin depender del webhook):**
`GET https://api.mercadolibre.com/orders/search?seller={seller_id}&order.date_created.from={ISO}&sort=date_desc&limit=50&offset={N}` con `Authorization: Bearer {token}`. Ventana de 48hs hacia atrás (decisión de negocio de Opineco, no límite de la API). Paginado por offset/limit, corta cuando `len(results) < limit`.

**Enriquecimiento (igual en ambos caminos):**
1. Dedupe primero: si `OrderID` o `ShippingID` ya existen localmente, se descarta (evita gastar llamadas de más).
2. Si es nuevo y tiene `shipping.id`: `GET /shipments/{shipping_id}` para traer `substatus`.
3. **Filtro específico de Opineco:** solo se guarda si `substatus == "ready_to_print"` (la etiqueta ya está lista para imprimir en bodega — el gatillo real de cuándo arrancar el fulfillment). Esto reemplaza mi supuesto anterior de filtrar por `shipping.status` top-level — acá el filtro real es el **substatus** `ready_to_print`, más específico.

**Multi-cuenta:** hay 7 pares seller_id/token configurados, pero **solo 3 activos hoy** (confirmado 2026-09-10): `CUENTA4=2914177676`, `CUENTA5=1615390484`, `CUENTA6=1613511081` (coincide con lo que ya vimos en la tabla `publicaciones_ml_propias`). Las otras 4 son cuentas viejas/eliminadas.

**Modelo de datos de referencia:**

| Campo | Origen |
|---|---|
| `OrderID` | `orders/{id}` o `orders/search` → `.id` |
| `ShippingID` | `.shipping.id` de la orden |
| `FechaOrden` | `date_created` de la orden/envío |
| `Cuenta` | cuál de las 3 cuentas activas generó la orden |
| `Via` | `"WEBHOOK"` o `"ENDPOINT"` + substatus — para debuggear cuál camino falló si algo no aparece |

**Para cuando implementemos esto:** el hub debería pollear `/meli/webhook/consume` (camino rápido) + correr el job de reconciliación de 48hs (camino de respaldo) igual que ya hace FileMaker, dedupeando contra `ventas_mercadolibre` por `order_id`, y filtrando por `substatus == "ready_to_print"` en vez del `shipping.status` genérico que documenté en la sección 1.

---

## 2. Tawk.to

### Eventos de webhook disponibles (son solo 4, no más)
1. `chat:start` — se dispara con el primer mensaje del chat.
2. `chat:end` — al terminar el chat.
3. **Transcripción de chat nueva** — se manda automáticamente 3 minutos después de que termina toda actividad, con la conversación completa.
4. `ticket:create` — al crearse un ticket.

### Limitación importante encontrada
**No existe un evento específico para "chat esperando respuesta" o "mensaje nuevo sin contestar"** — que es literalmente el caso de uso que describe la spec original ("chat nuevo en Tawk.to — cliente esperando"). Tawk solo notifica el inicio del chat (`chat:start`), no mensajes intermedios ni el estado de "esperando agente".

**Recomendación:** usar `chat:start` como proxy — cualquier chat que arranca genera la alerta roja. No es 100% preciso (no distingue si ya lo atendió alguien), pero es la única señal en tiempo real que ofrece el webhook nativo. Si más adelante hace falta algo más fino (ej. tiempo de espera sin respuesta), tocaría evaluar la API REST/Admin de Tawk (si expone consultas de estado) en vez de webhooks — no lo investigué en este pase por no ser parte de lo pedido ahora.

### Seguridad
Cada webhook viene firmado con **HMAC-SHA1** usando un secret key que se configura en el panel de Tawk — el hub debe validar la firma antes de procesar, para no aceptar payloads falsos.

### Reintentos
Reintenta hasta por 12 horas si el endpoint no responde 2xx, o si no hay respuesta dentro de 30 segundos.

**Fuentes:**
- [Webhooks — tawk.to Developer Portal](https://developer.tawk.to/webhooks/)
- [Creating and managing Webhooks — Help Center](https://help.tawk.to/article/creating-and-managing-webhooks)

---

## 3. Correo — GoDaddy con dominio de la empresa

### Confirmado: es el webmail legacy (no Microsoft 365) — y es cPanel, no la infra propia de GoDaddy
No hay webhook nativo disponible — descartada la opción de Microsoft Graph API. Único camino viable: **IMAP con IDLE**.

**Host real confirmado:** `opineco.cl` (puerto 993) — **no** `imap.secureserver.net` como se había asumido inicialmente. `imap.secureserver.net` conecta pero rechaza la autenticación (`AUTHENTICATIONFAILED`); el host correcto se encontró en un perfil `.mobileconfig` de Apple Mail que reveló `IncomingMailServerHostName: opineco.cl` — es hosting cPanel (confirmado por el `PayloadIdentifier: cpanel.mail.org...` del perfil), donde el dominio propio funciona directo como host de IMAP/SMTP.

### Plan de implementación (IMAP + IDLE)
- Librería recomendada: **`imapflow`** (Node) — soporta IDLE nativamente y tiene mejor manejo de reconexión que `node-imap`.
- El hub abre una conexión persistente al servidor IMAP de GoDaddy (`imap.secureserver.net`, puerto 993/TLS — confirmar el host exacto en el panel de GoDaddy de la cuenta) y queda en modo `IDLE` sobre la carpeta `INBOX`.
- Cuando el servidor avisa un mensaje nuevo, el hub lo trae (`FETCH` del `envelope`: remitente + asunto), arma la alerta y hace `POST /api/alertas` (`source: 'correo'`) internamente — no hace falta pasar por HTTP, puede ser una función directa dentro del mismo proceso del hub.
- **Reconexión:** las conexiones IMAP se caen (timeouts del servidor, red) — hay que envolver la conexión en un loop de reconexión automática con backoff, si no el flujo de correo se corta silenciosamente.
- **Credenciales:** requiere guardar usuario/contraseña (o app password si GoDaddy lo soporta) del buzón de la empresa como variable de entorno en Railway — nunca en el repo.
- Esto corre **dentro del proceso del hub** (no como integración externa), a diferencia de Discord/Tawk/ML que llegan por webhook — es la única pieza que mantiene una conexión saliente persistente en vez de recibir datos entrantes.

**Fuentes:**
- [Sign in to webmail — Microsoft 365 from GoDaddy](https://www.godaddy.com/help/sign-in-to-webmail-40058)
- [Microsoft 365 from GoDaddy — Help Center](https://www.godaddy.com/help/microsoft-365-from-godaddy-1000005)
- [Receive change notifications through webhooks — Microsoft Graph](https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks)
- [Use the Outlook mail REST API — Microsoft Graph](https://learn.microsoft.com/en-us/graph/api/resources/mail-api-overview?view=graph-rest-1.0)

---

## Resumen de lo que queda abierto (no lo pude cerrar por investigación)

1. **ML:** confirmar manualmente la tabla completa de estados/sub-estados de envío en el dev portal (bloqueó el fetch automatizado por anti-bot) — solo para verificar que no hay un estado intermedio entre `ready_to_ship` y `shipped` que debiéramos mostrar distinto.
2. **Correo:** confirmar cuál producto de GoDaddy tienen — Microsoft 365 (webhook real) vs. webmail legacy (solo IMAP). Es la decisión que más cambia el trabajo de programación.
