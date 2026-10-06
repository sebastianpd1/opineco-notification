#!/bin/zsh -l
# Doble clic: abre el Normalizador web. Copia este archivo al Escritorio (ver README).
DIR="$HOME/opineco-notification/normalizador"
cd "$DIR" || { echo "No encuentro la carpeta $DIR"; read -k1 "?Presiona una tecla para cerrar"; exit 1; }
echo "Actualizando el normalizador..."
git pull -q origin claude/loving-ramanujan-mz9zg6 || echo "(No se pudo actualizar; sigo con la versión que hay.)"
pkill -f "$DIR/web.py" 2>/dev/null && sleep 1   # cierra una ventana anterior que haya quedado abierta
echo "Abriendo el normalizador en el navegador. Deja esta ventana abierta mientras lo usas."
python3 "$DIR/web.py"
