# Sistema de Alertas de Comunicaciones — Opine Company Ltda.

Hub central de alertas para la empresa: centraliza avisos de Discord, Tawk.to, correo, MercadoLibre y pedidos de FileMaker, y los distribuye a pantallas de sucursal (Fire TV Stick) y celulares de empleados (PWA + push).

## Estado actual

Ver [TODO.md](TODO.md) para el detalle actualizado ítem por ítem.

| Pieza | Estado |
|---|---|
| Diseño del dashboard de sucursal | ✅ Validado (`server/public/pantalla-sucursal.html`) |
| Hub central (Node/Express + Supabase) | ✅ Deployado en Railway |
| Identidad de sucursal por URL (`?sucursal=<id>`) | ✅ |
| Pedidos a Retirar/Despachar (FileMaker → Supabase directo) | ✅ Scripts en `filemaker-scripts.md` |
| Notificaciones rojas + acuse de recibo | ✅ |
| Bot de Discord | 🟡 Implementado, falta token/canales reales |
| Webhook Tawk.to | 🟡 Implementado, falta configurar en el panel de Tawk |
| Mercado Libre | ⬜ En pausa (arquitectura investigada, ver `investigacion-integraciones.md`) |
| Integración correo (GoDaddy/IMAP) | ⬜ No iniciado |
| PWA + push web | ⬜ No iniciado |
| Deploy en Fire TV Stick | ⬜ No iniciado |

## Estructura

```
/server/                          → hub Node/Express (todo el backend + sirve el dashboard)
/server/server.js                 → API + rutas
/server/discord-bot.js            → bot de Discord (Gateway API)
/server/public/pantalla-sucursal.html → dashboard de sucursal (servido por el hub)
/supabase-schema.md, .sql         → esquema de las tablas en Supabase
/filemaker-scripts.md             → scripts reales de FileMaker (retirar/despachar/notificaciones)
/investigacion-integraciones.md   → investigación de ML, Tawk, correo
/TODO.md                          → estado ítem por ítem
/spec-sistema-alertas.md          → spec original (arquitectura, design tokens, decisiones de diseño)
```

## Empezar acá

1. Ver [TODO.md](TODO.md) para saber qué falta y qué está confirmado.
2. `cd server && npm install && npm start` para correr el hub en local (necesita `server/.env` con `SUPABASE_URL`/`SUPABASE_SECRET_KEY`, no versionado).
3. `spec-sistema-alertas.md` tiene las decisiones de diseño originales (por qué Discord vía bot y no webhook, por qué PWA y no app nativa, bugs de layout ya resueltos que no hay que reintroducir).

## Contexto técnico del negocio

- Backend existente: **FileMaker 16** (tiene `Insert From URL` nativo — no asumir que falta).
- Las sucursales no comparten red entre sí ni con FileMaker — todo pasa por el hub en Railway.
- Deploy de otras apps de la empresa ya vive en Railway (mismo lugar para este proyecto).
