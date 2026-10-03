# Normalizador de impresoras

Recorre la tabla COMPATIBILITY de FileMaker y deja cada impresora con un nombre normalizado, con
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
3. `python3 -m pip install -r requirements.txt` (usa el Google Chrome que ya tienes instalado).
4. `python3 norma.py chrome` → acepta las cookies de Google (e inicia sesión si quieres) y cierra.

## Exportar desde FileMaker

En COMPATIBILITY: Archivo → Exportar registros → **Valores separados por comas (.csv)**, juego de
caracteres **UTF-8**, con los campos en este orden: `ID`, `Brand`, `COMPATIBILITY`,
`ImpresoraNormalizada`. Guárdalo como `datos/compatibility.csv` y:

```
python3 norma.py importar datos/compatibility.csv
```

Si COMPATIBILITY trae varias impresoras en un mismo registro (separadas por salto de línea, coma o
punto y coma), se separan solas y quedan como `ID#1`, `ID#2`...

## Correr

Abre Claude Code en esta carpeta (`claude`) y escribe `/lote` para un lote de 5 grupos. Para que
siga solo: `/loop /lote`. Ver el avance: `python3 norma.py estado`.

## Resultado

`python3 norma.py exportar` deja en `datos/salida/`:

- `aprobados.csv` — `fm_id, rid, texto, nombre, marca, familia, modelo, variante` para importar a
  FileMaker (por ID).
- `revision_humana.csv` — lo que ningún agente pudo confirmar, con la nota del motivo.

`datos/` no se sube a git (tiene la base de trabajo y el perfil de Chrome).
