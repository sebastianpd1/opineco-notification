# Normalizador de impresoras — instrucciones para Claude Code (agente 1)

Opine Co vende tóner, polvo tóner y repuestos de impresoras. Cada SKU tiene su lista de impresoras
compatibles, pegada desde internet y catálogos de proveedores y escrita de mil formas (`P1102`,
`p1102w`, `1102`, `LaserJet 1102`, `LJ1102`). El objetivo es dejar cada una con un nombre normalizado
y confiable, para que en la web un cliente busque su impresora y vea todo lo que le sirve.

Hay dos fuentes por SKU (campo `origen`):
- `NORMALIZADA`: la tabla COMPATIBILIDADNORMALIZADA, hecha con IA hace un año. Casi siempre bien,
  pero **a veces alucinó**. Para estos textos tienes `en_compatibility_original`: lo que decía la
  tabla original para esos mismos SKU con los mismos números. Si está vacío o no calza, sospecha.
- `COMPATIBILITY`: el texto crudo, para los SKU que no tienen normalizada.

Todo se hace con `python3 norma.py <comando>` (ver `README.md`). La base de trabajo es
`datos/normalizador.db`; no la edites a mano.

## Cómo procesar un lote (lo dispara `/lote`)

1. `python3 norma.py siguiente-lote --grupos 5` — grupos que comparten marca + números. Cada grupo
   trae los **textos distintos** (con cuántas veces aparecen, SKU, categoría y nro. de parte de
   ejemplo), no cada fila: una decisión sobre un texto cubre todas sus repeticiones.
2. Dentro de cada grupo decide, texto por texto, a qué impresora real corresponde. Un grupo
   puede mezclar impresoras distintas que comparten número: sepáralas. La categoría del SKU ayuda
   (TINTAS vs TONER, POLVOS, PICKUP ROLLER...), y el nro. de parte es solo una pista, no una prueba.
3. Si tienes cualquier duda, busca en Google: `python3 norma.py google "HP LaserJet 1102 impresora"`.
   Lee los títulos y elige con criterio. Una búsqueda sirve para todo el grupo; no busques lo obvio.
4. Guarda las decisiones con `python3 norma.py proponer - <<'EOF' [...] EOF` (formato abajo).
5. Pide al subagente `verificador` que revise lo propuesto.
6. Responde con una línea de resumen (cuántos propuestos, cuántos a revisión humana).

El trabajo va por **tandas** que abre el usuario (`python3 norma.py tanda --registros 500`). Si
`siguiente-lote` responde `"tanda_completa": true`, termina la verificación pendiente y detente.
Nunca abras una tanda tú.

## Criterio (lo que un vendedor con 16 años en el rubro sabe)

- **La familia importa.** Números iguales en familias distintas son impresoras distintas:
  LaserJet vs Color LaserJet / LaserJet Pro Color, DeskJet vs Ink Tank / Smart Tank, OfficeJet,
  EcoTank vs Stylus, etc. Nunca juntes mono con color, ni cartucho con botella de tinta.
- Si el texto no trae familia (`1102`, `P1102`), dedúcela de los otros textos del grupo, de
  `en_compatibility_original` o de Google. Si no es seguro, va a revisión humana.
- Un texto `NORMALIZADA` que no aparece en `en_compatibility_original` puede ser una alucinación:
  confírmalo en Google o mándalo a revisión.
- Quita prefijos/sufijos de ruido (`LJ`→LaserJet, "printer", "impresora", "series", mayúsculas,
  espacios), pero conserva los que distinguen familia.
- **Variante:** si el texto trae variante (`w`, `dw`, `nw`, `dn`, `fdw`...) va en `variante` y en el
  nombre. Si no la trae, deja `variante` vacía y el nombre sin variante; no la inventes.
- `modelo` es el modelo base sin variante (`P1102`, `M251`, `2130`, `315`).
- Formato del nombre: `Familia Modelo+variante`, **sin la marca**, como lo escribe el fabricante
  (`LaserJet Pro P1102w`, `DeskJet 2130`, `HL-L2350DW`, `DCP-J100`). La marca va solo en el campo
  `marca`: en la web la marca es la categoría y dentro se listan los modelos, así que repetirla en el
  nombre sobra. Mantén el mismo nombre para la misma impresora en todo el trabajo (mira
  `ya_aprobados_en_este_grupo`).
- Si el texto no es una impresora (basura, un número de parte, un comentario), va a revisión humana.

## Marcas cruzadas

La marca del producto (SKU) **no** es necesariamente la de la impresora: muchos repuestos y tóners
sirven para varias marcas. Según la experiencia de Opine Co comparten modelos compatibles:
**Canon ↔ HP**, **Xerox ↔ Samsung**, **Kyocera ↔ Ricoh**. Además hay marcas que son la misma
fabricante con otro nombre (Ricoh = Savin / Lanier / Gestetner; Kyocera = Copystar / Utax /
Triumph-Adler; HP compró la línea de impresoras de Samsung).

- La `marca` es la **de la impresora**: un SKU HP que dice `imageCLASS MF632` va con
  `"marca": "Canon"` y `"nombre": "imageCLASS MF632"`, no es un error.
- El grupo (`HP|1102`) usa la marca que salió del texto. Si `marca_del_grupo_segun` es `producto`,
  el texto no traía marca ni familia y se asumió la del SKU: puede ser de la marca cruzada.
  Confírmalo (otros textos del grupo, `en_compatibility_original` o Google) antes de proponer.

## Reglas anti-alucinación (el código las verifica)

- **No escribas de memoria nada que no puedas respaldar.** Ante la duda: `"estado": "REVISION"`.
- Si usaste Google, copia en `evidencia_titulo` el título **tal cual** aparece en los resultados.
  `norma.py` comprueba que exista; si no está, el registro va a revisión humana.
- **Regla de oro:** los números de `modelo` deben estar en el texto original. Si agregas un número
  que no estaba, el código lo manda a revisión humana.

## Formato para `proponer`

Cada decisión nombra el `grupo` y los `textos` exactos (tal como vinieron) que cubre:

```json
[
  {"grupo": "HP|1102", "textos": ["P1102w", "p1102w", "HP LaserJet Pro P1102w"], "estado": "OK",
   "marca": "HP", "familia": "LaserJet Pro", "modelo": "P1102", "variante": "w",
   "nombre": "LaserJet Pro P1102w",
   "evidencia_titulo": "HP LaserJet Pro P1102w - Soporte HP", "evidencia_url": "https://...",
   "nota": "opcional"},
  {"grupo": "HP|251", "textos": ["M251"], "estado": "REVISION",
   "nota": "Puede ser M251n o M251nw, Google no aclara"}
]
```

Textos con variantes distintas (`P1102` y `P1102w`) van en decisiones distintas.
