# Normalizador de impresoras

## Normalizador web (recomendado)

Página para normalizar a mano, grupo por grupo, con ayuda de Google:

```
cd ~/opineco-notification/normalizador
python3 web.py
```

O con doble clic en **Normalizador** del Escritorio. Para crear ese ícono (una vez):
`cp ~/opineco-notification/normalizador/Normalizador.command ~/Desktop/`

Se abre http://127.0.0.1:8765, o el siguiente puerto libre que diga la Terminal (Control+C en la Terminal para cerrarla). Usa los mismos 3 CSV de
`datos/`. La primera vez los carga solos; `python3 web.py --reimportar` los vuelve a cargar (si ya
hay trabajo hecho pide confirmación). Cada vez que se abre guarda un respaldo del avance en
`datos/respaldos/` (los últimos 20); `datos/` no está en git, así que un `git pull` nunca lo toca.

- **Lista (izquierda):** SKU e impresora, ordenados por SKU. Solo muestra pendientes.
- **Al cargar los datos** agrupa por marca del SKU (inventario) + números (`P1102` + HP → `HP · 1102`).
  Los grupos donde todas las impresoras son idénticas (solo cambian espacios o saltos de línea) se
  completan solos y pasan a la pestaña **Completados**, donde cada uno se puede **Reabrir**.
- **Verificar:** muestra las variaciones del grupo con su cantidad (`P1102 +30`, `P 1102 +3`...).
  Cada una tiene casilla (desmarca las que son otra impresora) y **Normalizar como este**.
- **Campo de arriba:** escribe o corrige el nombre y aprueba con **Normalizar como este**.
- **Buscar y verificar en Google:** busca con Chrome y un agente (`claude -p`, tu plan) deja lo que
  encontró en el campo de arriba; ✓ = aparece en los resultados reales, ⚠ = revísalo.
- **Deshacer** revierte la última acción. **Exportar CSV** deja `datos/salida/normalizados_web.csv`.

### Conectado a FileMaker (recomendado)

Con `datos/filemaker.env` configurado (copiar `filemaker.env.ejemplo` y completar servidor, usuario y
clave de una cuenta con XML Web Publishing), las listas se leen **directo de FileMaker por XML** y no
hacen falta los CSV:

- Cada fila trae su `record-id`, y al normalizar (manual o Google) se edita el mismo campo en la tabla
  madre: `COMPATIBILIDADNORMALIZADA::Impresora` o `COMPATIBILITY::Printer`. Los automáticos no se envían.
- **Indicador ● FileMaker:** verde si responde 200 **con** datos de FileMaker; rojo si no responde o
  responde vacío (200 sin nada). Se revisa cada minuto (cada 20 s si está caído).
- Si FileMaker está caído, lo normalizado queda **Por enviar** y se manda solo cuando vuelve.
  **Deshacer** y **Reabrir** restauran en FileMaker el texto original.
- **Recargar desde FileMaker** trae registros nuevos conservando todo el avance (se reconoce cada
  fila por su record-id; antes se guarda un respaldo). La primera vez traspasa lo normalizado con CSV.
- En **Completados**, la columna FileMaker muestra ✓ escrito, ⏳ por enviar o ⚠ error (con Reintentar).

## Flujo automático por lotes (norma.py)

Recorre las compatibilidades de cada SKU en FileMaker y deja cada impresora con un nombre normalizado, con
el flujo de dos "empleados" hecho con Claude Code en tu Mac (usa tu suscripción, no la API):

```
CSV de FileMaker → agrupar por marca + números → Agente 1 (criterio + Google si duda)
                 → Agente 2 "verificador" (¿existe y está bien puesta?) → aprobados.csv
                                                                         → revision_humana.csv
```

- **Agente 1** = Claude Code con las instrucciones de `CLAUDE.md`.
- **Agente 2** = subagente `verificador` (`.claude/agents/verificador.md`).
- **Google** = `norma.py google`, que abre Chrome con Playwright, espera 12–25 s entre búsquedas,
  guarda cada búsqueda (nunca repite una) y se detiene si Google pide captcha para que lo resuelvas.
- **Anti-alucinación** (lo verifica el código, no la IA): el título citado como evidencia tiene que
  existir en los resultados reales de Google, y los números del modelo tienen que estar en el texto
  original. Si no, va a revisión humana.

## Instalación en el Mac (una vez)

1. Instalar Claude Code: https://code.claude.com/docs/en/setup
2. Clonar este repositorio y entrar a esta carpeta: `cd opineco-notification/normalizador`
3. `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` (entorno virtual del
   proyecto; `norma.py` lo usa solo. Usa el Google Chrome que ya tienes instalado).
4. `python3 norma.py chrome` → acepta las cookies de Google (e inicia sesión si quieres) y cierra.

## Exportar desde FileMaker

Tres exportaciones: Archivo → Exportar registros → **Valores separados por comas (.csv)**, juego de
caracteres **UTF-8**, **todos los registros**, con los campos **en este orden exacto**:

| Archivo | Tabla | Campos, en orden |
|---|---|---|
| `datos/inventario.csv` | INVENTARIO | `Item`, `NroParte`, `Marca`, `Categoria` |
| `datos/normalizada.csv` | COMPATIBILIDADNORMALIZADA | `SKU`, `Marca`, `Impresora`, `Categoria` |
| `datos/compatibility.csv` | COMPATIBILITY | `ID`, `InventoryItem`, `Brand`, `Printer` |

```
python3 norma.py importar --inventario datos/inventario.csv \
  --normalizada datos/normalizada.csv --compatibilidad datos/compatibility.csv
```

Regla: si un SKU tiene filas en la normalizada, se trabaja con esas; si no, con COMPATIBILITY. Para
los de la normalizada, el agente ve además lo que decía COMPATIBILITY para ese SKU, y así detecta
alucinaciones de la IA del año pasado. Si un campo trae varias impresoras (salto de línea, coma o
punto y coma), se separan solas.

## Correr

Se trabaja por **tandas** para controlar el consumo del plan:

1. En la Terminal: `python3 norma.py tanda --registros 500` (abre una tanda de 500 registros).
2. Abre Claude Code en esta carpeta (`claude`), escribe `/usage` y anota el porcentaje usado.
3. Escribe `/loop /lote`. Procesa lotes hasta completar los 500 registros y se detiene solo.
4. Escribe `/usage` de nuevo: la diferencia es lo que costó la tanda. `python3 norma.py tanda`
   muestra cuántos registros se aprobaron, cuántos fueron a revisión, búsquedas y minutos.

Sin tanda abierta el agente no procesa nada. Avance general: `python3 norma.py estado`.

Si cambian las reglas, `python3 norma.py reabrir` devuelve a pendiente lo que fue a revisión humana
(o `--nota "texto"` para solo algunos) y se reprocesa en la próxima tanda.

## Resultado

`python3 norma.py exportar` deja en `datos/salida/`:

- `aprobados.csv` — `origen, sku, fm_id, texto, nombre, marca, familia, modelo, variante, categoria`
  para importar a FileMaker.
- `revision_humana.csv` — lo que ningún agente pudo confirmar, con la nota del motivo.

`datos/` no se sube a git (tiene la base de trabajo y el perfil de Chrome).
