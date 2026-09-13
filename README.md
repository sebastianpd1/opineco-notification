# Sistema de Alertas de Comunicaciones — Opine Company Ltda.

Hub central de alertas para la empresa: centraliza avisos de Discord, Tawk.to, correo, MercadoLibre y pedidos de FileMaker, y los distribuye a pantallas de sucursal (Fire TV Stick) y celulares de empleados (PWA + push).

## Estado actual

🟡 **Frontend mockeado y validado** (dummy data) — falta conectar backend real.

| Pieza | Estado |
|---|---|
| Diseño del dashboard de sucursal | ✅ Validado (`pantalla-sucursal.html`) |
| Hub central (Railway) | ⬜ No iniciado |
| Script de FileMaker → hub | ⬜ No iniciado |
| Bot de Discord | ⬜ No iniciado |
| Webhook Tawk.to | ⬜ No iniciado |
| Polling MercadoLibre | ⬜ No iniciado |
| Integración correo | ⬜ No iniciado |
| PWA + push web | ⬜ No iniciado |
| Deploy en Fire TV Stick | ⬜ No iniciado |

## Estructura

```
/pantalla-sucursal.html      → dashboard de sucursal, standalone, dummy data (referencia visual/comportamiento)
/spec-sistema-alertas.md     → spec completa: arquitectura, design tokens, componentes, bugs ya resueltos, roadmap
```

## Empezar acá

1. Leer `spec-sistema-alertas.md` completo antes de tocar código — tiene las decisiones ya tomadas (por qué Discord vía bot y no webhook, por qué PWA y no app nativa, por qué la tabla del calendario es nativa y no iframe) y tres bugs de layout ya resueltos que no hay que reintroducir.
2. Abrir `pantalla-sucursal.html` en el navegador para ver el resultado esperado — es la referencia de diseño final, no rediseñar desde cero.
3. Seguir el orden de prioridad de la sección 5 de la spec: hub en Railway primero, después FileMaker, después el resto de las integraciones.

## Contexto técnico del negocio

- Backend existente: **FileMaker 16** (tiene `Insert From URL` nativo — no asumir que falta).
- Las sucursales no comparten red entre sí ni con FileMaker — todo pasa por el hub en Railway.
- Deploy de otras apps de la empresa ya vive en Railway (mismo lugar para este proyecto).
