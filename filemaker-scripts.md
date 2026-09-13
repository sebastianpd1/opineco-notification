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
            [ "sucursal_id" ; VENTAS::SucursalID ; JSONString ] ;
            [ "cliente" ; $cliente ; JSONString ]
        )
    ) & " " &
    "--max-time 10"
]
```

Usa las variables que el script ya tiene seteadas (`$id` = `VENTAS::ID`, `$cliente` = `CLIENTES::Nombre`) — no hace falta declarar nada nuevo, solo agregar este bloque después de los `Set Field` de `DETALLEENVIOS` en cada rama.

## 2. Delete de `pedidos_despachar` (cuando se emite la etiqueta)

**Secuencia confirmada:** venta → click en botón despacho (script de la sección 1, pasa a `DETALLEENVIOS`/tabla de espera) → más tarde, se emite la etiqueta por API → corre el script corto que ya sincroniza `DETALLEENVIOS` hacia la tabla `despachos` (métricas). Ese script corto es el punto de cierre real — se le agrega el `DELETE`:

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

# --- NUEVO: sacarlo de la TV, ya se etiquetó/despachó ---
Insert From URL [ Select target: <ninguno> ; Target: $resultado ;
    "https://kojtfaxzeyfmgqnpckdo.supabase.co/rest/v1/pedidos_despachar?id=eq." & $venta_id ;
    cURL options:
        "-X DELETE " &
        "--header \"apikey: TU_SUPABASE_SECRET_KEY_ACA\" " &
        "--header \"Authorization: Bearer TU_SUPABASE_SECRET_KEY_ACA\" " &
        "--max-time 10"
]
```

(el bloque de arriba hasta el primer `Insert from URL` es el script existente, tal cual — solo se le agrega el último bloque nuevo al final)

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
            [ "sucursal_id" ; $sucursal ; JSONString ] ;
            [ "cliente" ; $cliente ; JSONString ]
        )
    ) & " " &
    "--max-time 10"
]
```

Usa las variables que el script de retiro ya tiene (`$id`, `$sucursal` = `VENTAS::SucursalID`, `$cliente`).

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

## Sobre las notificaciones rojas (`notificaciones_sucursal`) y el resto de las integraciones

Esas sí van a seguir pasando por el hub Node (no directo a Supabase desde FileMaker), porque el hub necesita centralizar la lógica de a qué sucursal(es) llega cada una — se documenta aparte cuando lleguemos a esa parte del TO-DO.
