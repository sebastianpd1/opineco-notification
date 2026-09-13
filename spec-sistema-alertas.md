# Sistema de Alertas de Comunicaciones — Spec para Claude Code

**Empresa:** Opine Company Ltda. (venta de toner/impresoras/copiadoras — Chile, Bolivia, USA)
**Backend existente:** FileMaker 16 (tiene `Insert From URL` nativo)
**Deploy target:** Railway

---

## 1. Objetivo del proyecto

Sistema central de alertas de la empresa. Cualquier evento relevante (mensaje en Discord, chat nuevo en Tawk.to, correo nuevo, pedido nuevo en FileMaker, venta en MercadoLibre) tiene que:

1. Mostrarse en una **pantalla física en cada sucursal** (TV chica conectada a un Fire TV Stick).
2. Generar una **push notification** en el celular de los empleados que no tienen TV cerca, abriendo un centro de notificaciones propio.

Las sucursales **no comparten red** entre sí ni con donde vive FileMaker — todo tiene que pasar por un hub central en la nube.

---

## 2. Arquitectura

```
FileMaker 16 (Insert From URL)  ─┐
Bot de Discord (Gateway API)     ─┤
Tawk.to (webhook nativo)         ─┼──▶  HUB CENTRAL (Railway / Node+Express)
Correo (Gmail API o similar)     ─┤        - normaliza todo a un formato común
MercadoLibre (polling API)       ─┘        - guarda estado (pedidos, alertas, ventas)
                                             │
                          ┌──────────────────┼──────────────────┐
                          ▼                  ▼                  ▼
                 TV de sucursal      PWA + push web       (futuro: más sucursales)
                 (Fire TV Stick,     (celulares sin TV
                  navegador en       cerca)
                  modo kiosko)
```

**Decisiones ya tomadas:**
- Discord se integra con un **bot propio escuchando el canal vía Gateway API** (no webhook duplicado) — así el sistema no depende de cómo esté armado el envío actual a Discord.
- Mobile: **PWA + push web**, no app nativa (evita burocracia de App Store/Play Store) ni bot de Telegram (queda "adentro" de Telegram en vez de ser un centro propio).
- Dispositivo de sucursal: **Fire TV Stick 4K Select**, HDMI a cualquier TV, modo kiosko con una app tipo "Fully Kiosk Browser" (sideload, gratis, sin suscripción) apuntando siempre a la URL del dashboard.

---

## 3. Formato de alerta normalizado (propuesto)

Todas las fuentes deben convertirse a esto antes de guardarse en el hub:

```json
{
  "id": "string",
  "source": "discord | tawk | correo | mercadolibre | pedido_retiro | pedido_despacho | manual",
  "title": "string",
  "text": "string",
  "timestamp": "ISO 8601",
  "priority": "normal | alta"
}
```

---

## 4. Frontend — estado actual (mockup con dummy data)

Archivo de referencia: **`pantalla-sucursal.html`** (adjunto, standalone, sin dependencias de build — HTML/CSS/JS vanilla en un solo archivo). Sirve como spec visual exacta: colores, tipografías, componentes y comportamiento ya están validados con el dueño del proyecto. Claude Code debe tomarlo como base y conectarlo a datos reales, no rediseñarlo.

### 4.1 Design tokens

| Token | Valor | Uso |
|---|---|---|
| `--deep` | `#17134F` | fondo, esquina superior |
| `--purple` | `#7A22C9` | fondo, esquina inferior |
| `--pink` | `#F0299D` | acento, texto de highlight |
| `--red` | `#FF3B30` | alertas |
| `--white` | `#F6F3FF` | texto principal |
| `--dim` | `rgba(246,243,255,0.62)` | texto secundario |
| `--panel` | `rgba(255,255,255,0.07)` | fondo de tarjetas (glass) |
| `--discord` | `#5865F2` | tile Discord |
| `--tawk` | `#22C35E` | tile Tawk.to |
| `--mail1`/`--mail2` | `#7FC7FB` / `#1E7FE0` | gradiente tile Correo |
| `--ml` | `#FFE600` | tile / acento MercadoLibre |

Tipografías: **Sora** (títulos, números) + **Inter** (texto), vía Google Fonts.
Fondo: gradiente diagonal `--deep` → `--purple` con un glow radial rosa en la esquina superior derecha.

### 4.2 Componentes (de arriba hacia abajo)

1. **Header** (flexbox, dos columnas forzadas 50/50 con `flex:1 1 0; min-width:0` — **no usar CSS Grid `1fr 1fr` acá**, causó bugs de colapso de columna repetidas veces):
   - Columna izquierda: nombre de sucursal + tag, fila de 3 íconos (Discord/Tawk/Correo, cada uno con badge rojo de contador), y debajo un widget ancho de MercadoLibre (ícono + contador + texto scrolleable en marquee horizontal con las ventas).
   - Columna derecha: día + fecha, y una tabla nativa de calendario 7 días (clases `.seven-days`, `.day-box`, `.day-name`, `.day-num`, `.ev-block` — colores extraídos directo de `calendario_fm.html`: fondo `#2d1f5e`, celda `#3d2d7a`, hoy `#a78bfa`, evento `#eab308`). **No usar iframe** — se intentó, el sandbox del entorno de chat lo bloqueaba en preview y complicaba sin necesidad; la tabla nativa replica el look exacto sin esa dependencia.

2. **Zona de alertas** (`#alertsZone`, ancho completo):
   - Barras rojas apiladas verticalmente, **persistentes** (no desaparecen solas), cada una con botón `×` para cerrar individualmente.
   - Límite de **3 barras visibles**. Al llegar una 4ª, todas colapsan en **una sola barra tipo marquee horizontal** con los mensajes concatenados y un único `×` que limpia todo.
   - Lógica ya implementada en JS vanilla (`addAlert`, `removeAlert`, `clearAll`, `render`) — solo falta conectarla a alertas reales entrantes (websocket o polling al hub) en vez de al botón de demo.

3. **Panel "Pedidos a Retirar"** y **"Pedidos a Despachar"** (2 columnas, 50/50):
   - Lista vertical con animación de scroll continuo (marquee vertical, CSS `@keyframes scrollUp`, contenido duplicado para loop sin corte).
   - Cada tarjeta: número de pedido, nombre/destino, detalle.

*(El panel de "Notificaciones" que existía en versiones anteriores del mockup fue removido a pedido — ya no debe reconstruirse salvo que se pida explícitamente.)*

### 4.3 Bugs ya resueltos (evitar reintroducirlos)

- **Nunca** dejar un contenedor flex con texto largo en una sola línea (`white-space:nowrap`, ej. el marquee de MercadoLibre) sin `min-width:0` en el contenedor padre flex — sin eso, el texto largo empuja el ancho de toda la página.
- El layout general **no debe** vivir dentro de un contenedor con `aspect-ratio` fijo + `overflow:hidden` — eso recortó contenido real cuando la página creció (alertas + calendario). Dejar que la página fluya naturalmente (`min-height:100vh`, sin recorte forzado).
- Las dos columnas del header deben repartirse el ancho con **flexbox + `flex:1 1 0` + `min-width:0`**, no con CSS Grid `1fr 1fr` (causó colapso de columna a ancho ~0 dos veces distintas).

---

## 5. Lo que falta conectar (backend real)

Prioridad sugerida:

1. **Hub central en Railway** — Node/Express, endpoint para recibir alertas normalizadas + endpoint que la pantalla consulta (polling cada pocos segundos o websocket).
2. **Script de FileMaker** — `Insert From URL` que dispare al hub cuando: cambia estado de pedido a "listo para retirar", se crea un despacho, o se agrega un evento de calendario.
3. **Bot de Discord** — Gateway API, escucha el canal configurado, reenvía cada mensaje al hub.
4. **Integración Tawk.to** — webhook nativo apuntando al hub.
5. **Integración MercadoLibre** — polling a su API por ventas nuevas.
6. **Integración correo** — Gmail API (u otro) por mensajes nuevos.
7. **PWA + push web** — para empleados sin TV cerca.
8. **Deploy en Fire TV Stick** — sideload de un kiosk browser, apuntando a la URL del dashboard ya con datos reales.

---

## 6. Archivos adjuntos

- `pantalla-sucursal.html` — mockup funcional completo con dummy data, referencia visual y de comportamiento definitiva.
