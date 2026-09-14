# TO-DO — Sistema de Alertas

Ver [supabase-schema.md](supabase-schema.md) para el detalle de tablas y [spec-sistema-alertas.md](spec-sistema-alertas.md) para arquitectura general.

## 0. Hub local (localhost)
- [x] Servidor Express sirviendo el dashboard + API en memoria (`server/server.js`)
- [x] Dashboard conectado a la API (alertas + pedidos) en vez de dummy data
- [x] Identidad de sucursal por URL: cada TV/kiosko apunta a `?sucursal=<id>` (ej. `?sucursal=providencia`) — el hub filtra alertas/pedidos por esa sucursal, y las alertas con `sucursal_id: null` son broadcast a todas
- [x] Hub migrado de memoria → Supabase real (`@supabase/supabase-js`, credenciales en `server/.env`) — probado end-to-end: crear pedido, listar filtrado por sucursal, cerrar con PATCH (queda `retirado_at`, no se borra), y alertas con broadcast vs. dirigida + acuse de recibo
- [ ] Cargar pedidos/ventas reales — hoy las tablas de Supabase están vacías salvo `sucursales` (los datos dummy de antes vivían solo en el array en memoria, nunca se insertaron en la base real)
- [x] Cargadas las 5 sucursales reales (`providencia`, `renca`, `agustinas`, `lampa`, `nunoa`) en el hub y en la tabla `sucursales` de Supabase

## 1. Supabase
- [x] Proyecto existente de la empresa (`kojtfaxzeyfmgqnpckdo`) — es compartido con otros sistemas, **no tocar nada fuera de las 5 tablas nuevas**
- [x] Creadas las 5 tablas: `sucursales`, `pedidos_retirar`, `pedidos_despachar`, `ventas_mercadolibre`, `notificaciones_sucursal` (renombrada de "alertas" porque ese nombre ya lo usa otra tabla no relacionada del mismo proyecto)
- [x] RLS activado en las 5 tablas nuevas
- [x] Seed inicial de `sucursales` con "providencia"
- [ ] **Seguridad pendiente:** rotar la contraseña de la base y la Supabase secret key — quedaron compartidas en texto plano en esta conversación
- [ ] Agregar más sucursales reales a la tabla `sucursales` a medida que se sepan sus ids/nombres
- [ ] Actualizar `server/server.js` para leer/escribir en Supabase (vía `@supabase/supabase-js` con la secret key) en vez del array en memoria

## 2. Pedidos a Retirar (FileMaker)
> Scripts en [filemaker-scripts.md](filemaker-scripts.md)
- [x] Confirmado: FileMaker escribe **directo a Supabase REST** (no vía hub) con la secret key, mismo patrón que ya usan en otros scripts
- [x] Confirmado: cola en vivo sin historial — `insert` al crear, `delete` real al retirar
- [x] Confirmado: notificación simple, alcanza con `id` + `sucursal_id` + `cliente` (sin `detalle` obligatorio)
- [x] Confirmada la tabla/campos reales: script "retiro local" → tabla `RETIROS`, variables `$id`/`$sucursal`/`$cliente` ya existentes
- [x] Trigger de cierre confirmado: después de la firma digital, junto a `RETIROS::Status = "OK"` y `VENTAS::IndicadorRetirado = "RETIRADO"`

## 3. Pedidos a Despachar (FileMaker)
> Scripts en [filemaker-scripts.md](filemaker-scripts.md)
- [x] Confirmado: mismo patrón insert/delete directo a Supabase REST
- [x] Confirmado: notificación simple, alcanza con `id` + `sucursal_id` + `cliente`
- [x] Confirmada la tabla/campos reales: script "envío a región" → tabla `DETALLEENVIOS`, variables `$id`/`$cliente` ya existentes
- [x] Trigger de cierre confirmado: el script corto que sincroniza `DETALLEENVIOS` → `despachos` (se dispara cuando se emite la etiqueta por API) — se le agrega el `DELETE` usando `$venta_id`

## 4. Mercado Libre — EN PAUSA, retomar cuando toque
> Arquitectura real confirmada en [investigacion-integraciones.md §1.1](investigacion-integraciones.md#11-arquitectura-real-de-ml-en-opineco-confirmada-reemplaza-los-supuestos-gen%C3%A9ricos-de-arriba) — **reemplaza** los supuestos genéricos de la sección 1 del mismo doc.
- [x] Confirmado: ya existe un relay propio en Railway (`mlwebhook-production.up.railway.app`) que recibe el webhook real de ML y lo encola — se consume con `GET /meli/webhook/consume`
- [x] Confirmado: hay un camino de respaldo 100% pull (`orders/search`, ventana de 48hs) que no depende del webhook — correr ambos
- [x] Confirmado: el filtro real de negocio es `substatus == "ready_to_print"` (no el `shipping.status` genérico que había documentado antes)
- [x] Confirmado: solo 3 de las 7 cuentas configuradas están activas — `CUENTA4`, `CUENTA5`, `CUENTA6`
- [x] Dedupe: antes de gastar una llamada de más, chequear si `OrderID`/`ShippingID` ya existen en `ventas_mercadolibre`
- [ ] Decidir si el hub consume directo el relay de Railway (`/meli/webhook/consume`) o si seguimos dependiendo de que FileMaker lo haga y nos avise a nosotros — **a definir cuando retomemos este ítem**
- [ ] Implementar el poll al relay + el job de respaldo de 48hs, con el filtro `ready_to_print` y upsert a `ventas_mercadolibre` (agregar campo `via` para debug)

## 5. Notificaciones rojas (FileMaker edit box → sucursal específica)
- [x] Script de FileMaker: `POST /api/alerts` directo a Supabase con `sucursal_id` + `text` (ver `filemaker-scripts.md`)
- [x] Endpoint hub `PATCH /api/alerts/:id` → setea `acknowledged_at` + `acknowledged_by`, no borra
- [x] Dashboard: click/swipe llama a `PATCH`, y agregado el carrusel "MENSAJE LEÍDO" (12h de vigencia)

## 6. Bot de Discord
- [x] Implementado en `server/discord-bot.js` (usa `discord.js`, Gateway API) — se conecta e inserta directo en `notificaciones_sucursal` vía el mismo cliente de Supabase del hub, no hace un POST HTTP a sí mismo
- [x] Mapeo canal→sucursal vía `DISCORD_CHANNELS` (JSON `{"canalId": "sucursal_id o null para broadcast"}`) — decisión tomada: configurable por canal en vez de asumir una sola opción, así cubre ambos casos sin tocar código
- [x] Badge-count implementado: `GET /api/alerts/counts?sucursal=X` cuenta alertas sin acuse por `source`, dashboard lo consulta cada 10s y esconde el badge si es 0 (ya no está hardcodeado a 3/2/48)
- [x] Bot creado, invitado al servidor, token y canales configurados en Railway — **confirmado funcionando en producción** (mensaje real de prueba llegó al dashboard)
- [x] Bug encontrado y arreglado en el camino: un `DISCORD_CHANNELS` mal formado tumbaba el hub entero (proceso compartido con el dashboard/API) — ahora el bot nunca puede crashear el proceso principal

## 7. Tawk.to
> Investigación completa en [investigacion-integraciones.md](investigacion-integraciones.md#2-tawkto)
- [x] Confirmado: solo existen 4 eventos de webhook — `chat:start`, `chat:end`, transcripción de chat, `ticket:create`. **No existe evento de "chat esperando respuesta"** — se usará `chat:start` como proxy (limitación aceptada, no hay alternativa nativa)
- [x] Implementado `POST /api/webhooks/tawk` en el hub — recibe `chat:start`, valida firma HMAC-SHA1 (si `TAWK_WEBHOOK_SECRET` está seteada), guarda en `notificaciones_sucursal`. Probado con payload simulado + firma válida/inválida.
- [x] Mapeo property→sucursal vía `TAWK_PROPERTIES` (mismo patrón que `DISCORD_CHANNELS`) — sin configurar, todo es broadcast
- [x] Webhook creado en Tawk, `TAWK_WEBHOOK_SECRET` cargado en Railway — **confirmado funcionando con un chat real** (no simulado): llegó al dashboard con firma válida
- [x] Un solo sitio/widget de Tawk — sin `TAWK_PROPERTIES`, todo queda broadcast a todas las sucursales

## 8. Correo (GoDaddy, dominio de la empresa)
> Investigación completa en [investigacion-integraciones.md](investigacion-integraciones.md#3-correo--godaddy-con-dominio-de-la-empresa)
- [x] Confirmado: es webmail legacy de GoDaddy (no Microsoft 365) → sin webhook nativo, va por **IMAP + IDLE**
- [ ] Confirmar el host IMAP exacto de la cuenta en el panel de GoDaddy (típicamente `imap.secureserver.net`, puerto 993)
- [ ] Implementar el listener con `imapflow` dentro del proceso del hub: conexión persistente en `IDLE` sobre `INBOX`, con reconexión automática ante caídas
- [ ] Guardar usuario/contraseña del buzón como variable de entorno en Railway (nunca en el repo)
- [ ] Al llegar mensaje nuevo, normalizar remitente+asunto y generar alerta (`source: 'correo'`)

## 9. PWA + push web (celulares sin TV cerca)
- [ ] Sin empezar — queda para después de tener las fuentes de datos reales funcionando

## 10. Deploy
- [x] Repo en GitHub (`sebastianpd1/opineco-notification`), deploy en Railway conectado a ese repo
- [x] Root Directory `server`, dashboard movido a `server/public/` (Railway no incluía archivos fuera del Root Directory)
- [x] Variables de entorno base cargadas (`SUPABASE_URL`, `SUPABASE_SECRET_KEY`) — probado en producción: `https://opineco-notification-production.up.railway.app/?sucursal=providencia`
- [ ] Cargar `DISCORD_BOT_TOKEN`/`DISCORD_CHANNELS` y `TAWK_WEBHOOK_SECRET`/`TAWK_PROPERTIES` en Railway cuando estén listos esos dos ítems
- [ ] Sideload de kiosk browser en Fire TV Stick apuntando a la URL de Railway (con `?sucursal=<id>` de cada sucursal)
