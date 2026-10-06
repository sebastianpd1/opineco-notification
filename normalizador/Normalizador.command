#!/bin/zsh -l
# Doble clic: abre el Normalizador web. Copia este archivo al Escritorio (ver README).
DIR="$HOME/opineco-notification/normalizador"
cd "$DIR" || { echo "No encuentro la carpeta $DIR"; read -k1 "?Presiona una tecla para cerrar"; exit 1; }
echo "Actualizando el normalizador..."
# Pull fresco: trae la última versión del programa. Tu avance (carpeta datos/) no está en git, así que
# nunca se toca; --ff-only evita pisar cambios tuyos (por ejemplo excepciones-sufijo.txt).
git fetch -q origin claude/loving-ramanujan-mz9zg6 && git pull -q --ff-only origin claude/loving-ramanujan-mz9zg6 \
  || echo "(No se pudo actualizar; sigo con la versión que hay. Tu avance está intacto.)"
pkill -f "$DIR/web.py" 2>/dev/null && sleep 1   # cierra una ventana anterior que haya quedado abierta
echo "Abriendo el normalizador en el navegador. Deja esta ventana abierta mientras lo usas."
python3 "$DIR/web.py"
