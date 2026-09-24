# Scripts de FileMaker — Pedidos a Retirar / Despachar

FileMaker escribe **directo a la REST API de Supabase** (mismo patrón que ya usan en scripts existentes: `Insert From URL` en un solo bloque, secret key en los headers, `Quote(JSONSetElement(...))` para armar el body) — no hace falta pasar por el hub Node para esto.

Proyecto: `https://kojtfaxzeyfmgqnpckdo.supabase.co`. Tablas: `pedidos_retirar` y `pedidos_despachar` — colas en vivo, sin historial (`insert` al crear, `delete` al cerrar). Confirmado: son notificaciones simples, alcanza con **id de venta + sucursal + cliente** (la fecha la pone Supabase sola con `created_at`) — `detalle`/`destino`/`transportista` quedaron como columnas opcionales por si alguna vez hace falta más info, pero no son obligatorias.

---

---

## 1. Insert a `pedidos_despachar` (venta a región — script "envío a región")

Se agrega **dentro del mismo script que ya crea el registro en `DETALLEENVIOS`**, un bloque de `Insert From URL` por cada rama (la del `If` y la del `Else`, ya que ambas crean un envío):

```
Insert From URL [
  Select target: <ninguno> ;
  Target: $resultado ;
  "https://kojtfaxzeyfmgqnpckdo.supabase.co/rest/v1/pedidos_despachar" ;
  cURL options:
    "-X POST " &
    "--header \"apikey: " & $$SUPABASE_KEY & "\" " &
    "--header \"Authorization: Bearer " & $$SUPABASE_KEY & "\" " &
    "--header \"Content-Type: application/json\" " &
    "--data " & Quote (
        JSONSetElement ( "{}" ;
            [ "id" ; $id ; JSONString ] ;
            [ "sucursal_id" ; Lower ( VENTAS::SucursalID ) ; JSONString ] ;
            [ "cliente" ; $cliente ; JSONString ]
        )
    ) & " " &
    "--max-time 10"
]
```

Usa las variables que el script ya tiene seteadas (`$id` = `VENTAS::ID`, `$cliente` = `CLIENTES::Nombre`) — no hace falta declarar nada nuevo, solo agregar este bloque después de los `Set Field` de `DETALLEENVIOS` en cada rama.

**Sobre mayúscula/minúscula:** confirmado que el campo de FileMaker admite `RENCA` o `renca` indistintamente, así que no hay que depender de que cada script lo escriba bien — la base de datos ahora normaliza sola cualquier `sucursal_id` a minúscula antes de guardar (trigger `normalizar_sucursal_id` en `supabase-schema.sql`). El `Lower()` de estos scripts queda como algo opcional/prolijo, no es la única red de seguridad.

## 2. Al emitir la etiqueta: YA NO se borra, ahora se guarda el `transportista`

**Cambio importante respecto a lo que había antes:** hasta ahora este script borraba `pedidos_despachar` apenas se emitía la etiqueta — pero eso pasa ANTES de que el paquete siquiera salga de la sucursal, así que si el courier nunca lo entregaba, no había forma de darse cuenta (se perdía de la pantalla igual). Con el widget nuevo de "Enviados, esperando entrega" (§5 abajo) el pedido tiene que seguir vivo en Supabase hasta que el courier confirme la entrega. Este script pasa a hacer un `PATCH` (no `DELETE`) para guardar qué courier se usó:

**Secuencia confirmada:** venta → click en botón despacho (script de la sección 1, pasa a `DETALLEENVIOS`/tabla de espera) → más tarde, se emite la etiqueta por API → corre el script corto que ya sincroniza `DETALLEENVIOS` hacia la tabla `despachos` (métricas). Ese es el punto donde se sabe qué courier se usó:

```
Set Variable [ $venta_id ; Value: DETALLEENVIOS::VentasID ]
Set Variable [ $comuna ; Value: DETALLEENVIOS::AuxiliarComuna ]
Set Variable [ $fecha ; Value: GetAsText ( DETALLEENVIOS::Fecha ) ]
If [ IsEmpty ( $venta_id ) or IsEmpty ( $comuna ) ]
    Exit Script [ Text Result: ]
End If
Set Variable [ $json ; Value: JSONSetElement ( "{}" ; ["venta_id"; $venta_id; JSONNumber] ; ["comuna"; $comuna; JSONString] ; ["fecha"; $fecha; JSONString] ) ]
Insert from URL [ Select ; With dialog: Off ; $resultado ;
    "https://kojtfaxzeyfmgqnpckdo.supabase.co/rest/v1/despachos" ;
    cURL options: "-X POST " & "--header \"apikey: TU_SUPABASE_SECRET_KEY_ACA\" " & ... ]

# --- NUEVO: guardar qué courier se usó (reemplaza al DELETE que había acá) ---
Insert From URL [ Select target: <ninguno> ; Target: $resultado ;
    "https://kojtfaxzeyfmgqnpckdo.supabase.co/rest/v1/pedidos_despachar?id=eq." & $venta_id ;
    cURL options:
        "-X PATCH " &
        "--header \"apikey: TU_SUPABASE_SECRET_KEY_ACA\" " &
        "--header \"Authorization: Bearer TU_SUPABASE_SECRET_KEY_ACA\" " &
        "--header \"Content-Type: application/json\" " &
        "--data " & Quote (
            JSONSetElement ( "{}" ;
                [ "transportista" ; $transporte ; JSONString ]  // "STARKEN" / "RAPPI" / "BLUE", tal cual lo maneja FileMaker hoy
            )
        ) & " " &
        "--max-time 10"
]
```

(el bloque de arriba hasta el primer `Insert from URL` es el script existente, tal cual — el bloque nuevo reemplaza al `DELETE` que estaba acá antes)

## 5. Widget "Enviados, esperando entrega" — el `PATCH` que falta

Esto va en el/los scripts que **ya existen** y consultan periódicamente Starken/Rappi/Blue Express (los que llenan `DETALLEENVIOS::StarkenEstado` y equivalentes) — se le agrega un `PATCH` más, justo después de guardar el estado localmente, usando el mismo `$venta_id`/`id` de siempre:

```
Insert From URL [ Select target: <ninguno> ; Target: $resultado ;
    "https://kojtfaxzeyfmgqnpckdo.supabase.co/rest/v1/pedidos_despachar?id=eq." & $venta_id ;
    cURL options:
        "-X PATCH " &
        "--header \"apikey: TU_SUPABASE_SECRET_KEY_ACA\" " &
        "--header \"Authorization: Bearer TU_SUPABASE_SECRET_KEY_ACA\" " &
        "--header \"Content-Type: application/json\" " &
        "--data " & Quote (
            JSONSetElement ( "{}" ;
                [ "estado_envio" ; $estado ; JSONString ]
            )
        ) & " " &
        "--max-time 10"
]
```

`$estado` es la misma variable que ya arma cada script (texto de Starken, `EstadoNombre` de Rappi, o `title` de Blue Express) — se manda tal cual, sin traducir nada; la traducción a "pendiente / en tránsito / entregado" la hace el hub (`server/couriers.js`).

**El `DELETE` final ya NO va en FileMaker:** el hub corre un job cada 10 minutos que revisa `pedidos_despachar`, detecta solo qué filas llegaron a un estado final (`ENTREGADO` / `Entregado` / `DL`) y las borra — FileMaker no necesita agregar ninguna lógica de borrado, solo mandar el `PATCH` de arriba cada vez que consulta el estado.

---

## 3. Insert a `pedidos_retirar` (retiro local — script "retiro local")

Mismo patrón, usando la tabla `RETIROS` que ya usan de referencia. Se agrega después de los `Set Field [RETIROS::...]` en **ambas ramas** del `If [not IsEmpty(VENTAS::FacturaBoletaContainer)]` (líneas ~19 y ~37 del script que mostraste):

```
Insert From URL [
  Select target: <ninguno> ;
  Target: $resultado ;
  "https://kojtfaxzeyfmgqnpckdo.supabase.co/rest/v1/pedidos_retirar" ;
  cURL options:
    "-X POST " &
    "--header \"apikey: " & $$SUPABASE_KEY & "\" " &
    "--header \"Authorization: Bearer " & $$SUPABASE_KEY & "\" " &
    "--header \"Content-Type: application/json\" " &
    "--data " & Quote (
        JSONSetElement ( "{}" ;
            [ "id" ; $id ; JSONString ] ;
            [ "sucursal_id" ; Lower ( $sucursal ) ; JSONString ] ;
            [ "cliente" ; $cliente ; JSONString ]
        )
    ) & " " &
    "--max-time 10"
]
```

Usa las variables que el script de retiro ya tiene (`$id`, `$sucursal` = `VENTAS::SucursalID`, `$cliente`) — mismo motivo del `Lower()` que en la sección 1 (la FK de `sucursal_id` exige minúscula).

## 4. Delete de `pedidos_retirar` (cuando el cliente lo retira)

**Trigger confirmado:** justo después de la firma digital, donde ya setean `RETIROS::Status = "OK"` y `VENTAS::IndicadorRetirado = "RETIRADO"`:

```
Set Field [ RETIROS::Status ; "OK" ]
Set Field [ RETIROS::Factura ; "" ]
Set Field [ VENTAS::IndicadorRetirado ; "RETIRADO" ]

Insert From URL [
  Select target: <ninguno> ;
  Target: $resultado ;
  "https://kojtfaxzeyfmgqnpckdo.supabase.co/rest/v1/pedidos_retirar?id=eq." & VENTAS::ID ;
  cURL options:
    "-X DELETE " &
    "--header \"apikey: " & $$SUPABASE_KEY & "\" " &
    "--header \"Authorization: Bearer " & $$SUPABASE_KEY & "\" " &
    "--max-time 10"
]

Commit Records/Requests [ With dialog: Off ]
```

(agregado antes del `Commit Records/Requests` que ya tenían, para no cambiar el orden del resto del script)

---

## Nota aparte: el WhatsApp de Agustinas

El script de retiro local también dispara un mensaje de WhatsApp vía `api.callmebot.com` cuando `$sucursal = "AGUSTINAS"` — es una automatización aparte, sin relación con Supabase/el hub. La dejo mencionada acá solo para que quede registrado que existe, pero no la toco ni la documento más — no es parte de este sistema.

---

## Manejo de errores (recomendado, no bloqueante)

Si Supabase no responde, `Insert From URL` falla pero el registro en FileMaker ya quedó guardado — no bloquear al operario por esto. Revisar `$resultado` (trae el body de la respuesta o el error de cURL) y loguearlo si quieren poder reintentar después. Mismo patrón que ya usan con `--max-time 10`.

## 6. Notificación manual (banner rojo) desde el "edit box" de FileMaker

**Corrección importante (ya probado en producción y falló así):** esto **no va directo a Supabase** como el resto de los scripts de esta guía — tiene que pasar por el `POST /api/alerts` del hub Node, porque el push real (lo que hace saltar el ícono/notificación del sistema operativo, no solo el banner en la TV) solo lo dispara el hub. Un insert directo a Supabase deja la alerta visible en el banner rojo de la TV, pero **nunca manda push** a los celulares/computadoras suscritos.

```
Insert From URL [
  Select target: <ninguno> ;
  Target: $resultado ;
  "https://opineco-notification-production.up.railway.app/api/alerts" ;
  cURL options:
    "-X POST " &
    "--header \"Content-Type: application/json\" " &
    "--data " & Quote (
        JSONSetElement ( "{}" ;
            [ "sucursal_id" ; Lower ( $sucursal ) ; JSONString ] ;
            [ "source" ; "manual" ; JSONString ] ;
            [ "text" ; $texto ; JSONString ]
        )
    ) & " " &
    "--max-time 10"
]
```

No lleva `apikey`/`Authorization` de Supabase — es un endpoint propio del hub, sin key hoy (si en algún momento se configura `HUB_API_KEY` en Railway, ahí sí habría que agregar el header `X-Hub-Key`).

`$sucursal` = a qué sucursal va dirigida (con `Lower()` igual que antes, por las dudas — la base también normaliza sola); si se deja `sucursal_id` vacío/null, la alerta es broadcast a todas las pantallas. `$texto` es el mensaje que escribe el operario. Esta alerta sale en el banner rojo grande, hace sonar la campanita de la TV, y ahora sí manda push real.

**Cierre:** esto no se borra desde FileMaker — se cierra desde la propia TV (tocando la alerta) o sola a las 24hs si nadie la toca (ver `server/server.js`, `limpiarAlertasVencidas`).
