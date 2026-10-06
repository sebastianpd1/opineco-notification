---
description: Procesa un lote del normalizador de impresoras (agente 1 + verificador)
---

Procesa un lote siguiendo `CLAUDE.md`: `siguiente-lote`, decide con criterio (Google solo si hay
duda), `proponer`, y luego pide al subagente `verificador` que revise lo propuesto. Termina con
`python3 norma.py tanda` y un resumen de una línea.

Si `siguiente-lote` responde `"tanda_completa": true`: pide al `verificador` que termine lo que quede
propuesto, muestra `python3 norma.py tanda`, di "Tanda completa" y **detente** (si estás en `/loop`,
termina el loop). No abras una tanda nueva: eso lo decide el usuario después de revisar el consumo.

**Ritmo en `/loop`:** no hay nada externo que esperar entre lotes; en cuanto el verificador termine y
la tanda no esté completa, programa el siguiente lote con la espera mínima (60 segundos). Nunca dejes
esperas largas de 10-20 minutos.
