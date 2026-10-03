---
description: Procesa un lote del normalizador de impresoras (agente 1 + verificador)
---

Procesa un lote siguiendo `CLAUDE.md`: `siguiente-lote`, decide con criterio (Google solo si hay
duda), `proponer`, y luego pide al subagente `verificador` que revise lo propuesto. Termina con
`python3 norma.py estado` y un resumen de una línea. Si `siguiente-lote` devuelve `[]` y no queda nada
por verificar, di "Terminado" y ejecuta `python3 norma.py exportar`.
