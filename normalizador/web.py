#!/usr/bin/env python3
"""Normalizador web — página para normalizar impresoras a mano, grupo por grupo.

Uso:  python3 web.py            → abre http://127.0.0.1:8765 (o el siguiente puerto libre)
      python3 web.py --reimportar   → vuelve a cargar los CSV de datos/ (borra lo normalizado en la web)

Lee datos/inventario.csv, datos/normalizada.csv y datos/compatibility.csv (los mismos de norma.py).
Regla: los SKU con filas en la normalizada usan esas; los SKU sin normalizada usan COMPATIBILITY.
Grupos: marca del SKU según INVENTARIO + todos los números del texto. Cada registro es una fila tal cual;
lo único que se limpia son espacios y saltos de línea sobrantes. No se adivina nada.
"""
import json
import re
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import norma  # reutiliza lectura de CSV, limpieza, marca y la búsqueda en Google

BASE = Path(__file__).resolve().parent
DATOS = BASE / "datos"
DB = DATOS / "web.db"
PAGINA = BASE / "web"
PUERTO = 8765
ALGORITMO = "literal-1"  # si cambia y no hay nada normalizado, los CSV se recargan solos al abrir
LOCK = threading.Lock()

ESQUEMA = """
create table if not exists filas(
  id integer primary key,
  sku text, origen text, fm_id text, marca_item text,
  marca text,                         -- marca del SKU según INVENTARIO (la de la tabla si no está)
  texto text,                         -- impresora tal como venía, sin espacios/saltos sobrantes
  clave text,                         -- MARCA|números: la búsqueda "solo números + marca"
  estado text default 'PENDIENTE',    -- PENDIENTE o COMPLETADO
  nombre text,                        -- nombre normalizado elegido
  como text,                          -- auto (todas iguales) / manual / google
  accion integer);                    -- acción que lo completó (para deshacer)
create index if not exists ix_sku on filas(estado, sku, texto);
create index if not exists ix_clave on filas(clave, estado);
create table if not exists acciones(id integer primary key, fecha real, tipo text, detalle text);
"""


def conectar():
    DATOS.mkdir(exist_ok=True)
    c = sqlite3.connect(DB, check_same_thread=False)
    c.row_factory = sqlite3.Row
    c.executescript(ESQUEMA)
    return c


# ------------------------------------------------------------------ reglas (literales, sin adivinar)

def sin_espacios_sobrantes(texto):
    """Lo ÚNICO que se limpia: espacios y saltos de línea repetidos o en los bordes."""
    return re.sub(r"\s+", " ", texto or "").strip()


def clave(marca, texto):
    """Búsqueda = marca del SKU en el INVENTARIO + todos los números del texto (P1102 → HP|1102)."""
    return f"{marca}|{re.sub(r'[^0-9]', '', texto)}"


# ------------------------------------------------------------------ carga de los CSV

def importar(c):
    archivos = {k: DATOS / f"{k}.csv" for k in ("inventario", "normalizada", "compatibility")}
    faltan = [str(p) for p in archivos.values() if not p.exists()]
    if faltan:
        sys.exit("Faltan archivos: " + ", ".join(faltan))
    inventario = {norma.celda(f, 0): norma.celda(f, 2) for f in norma.leer_csv(archivos["inventario"])}

    filas_norm = norma.leer_csv(archivos["normalizada"])
    col = norma.detectar_columnas_normalizada(filas_norm)
    normalizada = [f for f in filas_norm if norma.celda(f, col["sku"]) and norma.celda(f, col["impresora"])]
    con_normalizada = {norma.celda(f, col["sku"]) for f in normalizada}

    def agregar(sku, origen, fm_id, marca_tabla, texto):
        # Cada registro es una fila, tal cual (solo sin espacios/saltos sobrantes).
        # Marca = la del INVENTARIO para ese SKU; si el SKU no está en el inventario, la de la tabla.
        texto = sin_espacios_sobrantes(texto)
        if not texto:
            return
        marca = (inventario.get(sku) or marca_tabla or "SIN MARCA").strip().upper()
        c.execute("insert into filas(sku, origen, fm_id, marca_item, marca, texto, clave) values(?,?,?,?,?,?,?)",
                  (sku, origen, fm_id, marca_tabla, marca, texto, clave(marca, texto)))

    c.execute("delete from filas")
    c.execute("delete from acciones")
    for f in normalizada:
        agregar(norma.celda(f, col["sku"]), "NORMALIZADA", "", norma.celda(f, col["marca"]),
                f[col["impresora"]])
    for f in norma.leer_csv(archivos["compatibility"]):
        sku = norma.celda(f, 1)
        if not sku or sku in con_normalizada:
            continue
        agregar(sku, "COMPATIBILITY", norma.celda(f, 0), norma.celda(f, 2), f[3] if len(f) > 3 else "")
    c.commit()
    total = c.execute("select count(*) from filas").fetchone()[0]
    print(f"Cargados {total} registros ({len(con_normalizada)} SKU desde la normalizada; el resto desde COMPATIBILITY).")


# ------------------------------------------------------------------ lógica

def igual(texto):
    """Dos textos son la misma variación solo si son idénticos después de limpiar espacios/saltos."""
    return sin_espacios_sobrantes(texto)


def nueva_accion(c, tipo, detalle):
    return c.execute("insert into acciones(fecha, tipo, detalle) values(?,?,?)",
                     (time.time(), tipo, json.dumps(detalle, ensure_ascii=False))).lastrowid


def loop_automatico(c):
    """Recorre los grupos (marca + números). Si todas las impresoras pendientes del grupo son iguales
    (solo cambian espacios/saltos de línea), las completa con ese nombre y desaparecen de la lista."""
    accion = nueva_accion(c, "loop", {})
    grupos = completados = filas = 0
    for (clave,) in c.execute("select distinct clave from filas where estado='PENDIENTE'").fetchall():
        grupos += 1
        textos = [r[0] for r in c.execute("select texto from filas where clave=? and estado='PENDIENTE'", (clave,))]
        if len({igual(t) for t in textos}) == 1:
            nombre = max(set(textos), key=textos.count)
            filas += c.execute("update filas set estado='COMPLETADO', nombre=?, como='auto', accion=?"
                               " where clave=? and estado='PENDIENTE'", (nombre, accion, clave)).rowcount
            completados += 1
    c.execute("update acciones set detalle=? where id=?",
              (json.dumps({"grupos_completados": completados, "registros": filas}), accion))
    c.commit()
    return {"grupos_revisados": grupos, "grupos_completados": completados, "registros_completados": filas}


def resumen(c):
    est = {r[0]: r[1] for r in c.execute("select estado, count(*) from filas group by estado")}
    grupos = c.execute("select count(distinct clave) from filas where estado='PENDIENTE'").fetchone()[0]
    return {"pendientes": est.get("PENDIENTE", 0), "completados": est.get("COMPLETADO", 0),
            "grupos_pendientes": grupos,
            "puede_deshacer": c.execute("select count(*) from acciones").fetchone()[0] > 0}


def lista(c, q, offset, limite):
    sql, args = "from filas where estado='PENDIENTE'", []
    if q:
        sql += " and (sku like ? or texto like ?)"
        args += [f"%{q}%", f"%{q}%"]
    total = c.execute("select count(*) " + sql, args).fetchone()[0]
    filas = [dict(r) for r in c.execute(
        "select id, sku, texto, marca, clave, origen " + sql + " order by sku, texto limit ? offset ?",
        args + [limite, offset])]
    return {"total": total, "filas": filas}


def grupo(c, clave):
    variaciones = {}
    for r in c.execute("select texto, sku, origen from filas where clave=? and estado='PENDIENTE'", (clave,)):
        v = variaciones.setdefault(igual(r["texto"]), {"textos": {}, "skus": set(), "origenes": set()})
        v["textos"][r["texto"]] = v["textos"].get(r["texto"], 0) + 1
        v["skus"].add(r["sku"])
        v["origenes"].add(r["origen"])
    salida = []
    for llave, v in variaciones.items():
        n = sum(v["textos"].values())
        salida.append({"llave": llave, "texto": max(v["textos"], key=v["textos"].get), "cantidad": n,
                       "skus": sorted(v["skus"])[:8], "total_skus": len(v["skus"]), "origenes": sorted(v["origenes"])})
    salida.sort(key=lambda x: -x["cantidad"])
    ya = [r[0] for r in c.execute("select distinct nombre from filas where clave=? and estado='COMPLETADO'", (clave,))]
    marca = clave.split("|", 1)[0]
    return {"clave": clave, "marca": marca, "variaciones": salida, "ya_normalizados": ya}


def normalizar(c, clave, llaves, nombre, como):
    nombre = sin_espacios_sobrantes(nombre)
    if not nombre:
        raise ValueError("El nombre está vacío.")
    if "," in nombre:
        raise ValueError("Deja un solo nombre (sin comas) antes de normalizar.")
    accion = nueva_accion(c, "normalizar", {"clave": clave, "nombre": nombre})
    n = 0
    for r in c.execute("select id, texto from filas where clave=? and estado='PENDIENTE'", (clave,)).fetchall():
        if igual(r["texto"]) in llaves:
            n += c.execute("update filas set estado='COMPLETADO', nombre=?, como=?, accion=? where id=?",
                           (nombre, como, accion, r["id"])).rowcount
    c.execute("update acciones set detalle=? where id=?",
              (json.dumps({"clave": clave, "nombre": nombre, "registros": n}, ensure_ascii=False), accion))
    c.commit()
    return {"registros": n, "nombre": nombre}


def deshacer(c):
    ultima = c.execute("select id, tipo, detalle from acciones order by id desc limit 1").fetchone()
    if not ultima:
        return {"mensaje": "No hay nada que deshacer."}
    n = c.execute("update filas set estado='PENDIENTE', nombre=null, como=null, accion=null where accion=?",
                  (ultima["id"],)).rowcount
    c.execute("delete from acciones where id=?", (ultima["id"],))
    c.commit()
    return {"mensaje": f"Deshecho ({ultima['tipo']}): {n} registros vuelven a pendientes."}


def exportar(c):
    salida = DATOS / "salida"
    salida.mkdir(exist_ok=True)
    ruta = salida / "normalizados_web.csv"
    import csv
    cur = c.execute("select sku, origen, fm_id, texto, marca, nombre, como from filas"
                    " where estado='COMPLETADO' order by sku, texto")
    filas = cur.fetchall()
    with open(ruta, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([d[0] for d in cur.description])
        w.writerows(filas)
    return {"archivo": str(ruta), "registros": len(filas)}


# ------------------------------------------------------------------ Google + agente

def ruta_claude():
    return shutil.which("claude") or str(Path.home() / ".local" / "bin" / "claude")


def buscar_google(consulta):
    """Usa la misma búsqueda de norma.py (Chrome con Playwright, pausas, caché y espera de captcha)."""
    r = subprocess.run([sys.executable, str(BASE / "norma.py"), "google", consulta],
                       capture_output=True, text=True, timeout=900, cwd=BASE)
    if r.returncode != 0:
        raise RuntimeError("La búsqueda en Google falló: " + (r.stderr or r.stdout)[-500:])
    return json.loads(r.stdout)["resultados"]


def preguntar_agente(marca, variaciones, resultados):
    lineas = "\n".join(f"- {r['titulo']} | {r['texto'][:250]}" for r in resultados) or "(sin resultados)"
    textos = ", ".join(f'"{v}"' for v in variaciones)
    prompt = f"""Eres un vendedor experto en impresoras, tóner y repuestos (Opine Co, Chile).
Estas son formas en que está escrita una impresora marca {marca} en nuestro sistema: {textos}.

Resultados reales de Google:
{lineas}

Tarea: di qué modelo(s) de impresora real corresponden, mirando SOLO estos resultados.
- Escribe cada nombre como lo escribe el fabricante, SIN la marca (ej: "LaserJet Pro P1102", "DCP-J100").
- Si hay más de un modelo posible, da todos.
- No inventes: cada nombre debe aparecer en los resultados de arriba.
Responde SOLO con JSON, sin texto antes ni después:
{{"candidatos": ["nombre 1", "nombre 2"], "explicacion": "una frase corta"}}"""
    carpeta = DATOS / "agente"  # carpeta neutra: así el agente no lee las instrucciones de norma.py
    carpeta.mkdir(exist_ok=True)
    r = subprocess.run([ruta_claude(), "-p", prompt, "--model", "sonnet", "--output-format", "text"],
                       capture_output=True, text=True, timeout=300, cwd=carpeta)
    if r.returncode != 0:
        raise RuntimeError("El agente (claude -p) falló: " + (r.stderr or r.stdout)[-500:])
    texto = r.stdout.strip()
    inicio, fin = texto.find("{"), texto.rfind("}")
    try:
        datos = json.loads(texto[inicio:fin + 1])
    except ValueError:
        raise RuntimeError("El agente no respondió en el formato esperado: " + texto[:300])
    return datos.get("candidatos") or [], datos.get("explicacion", "")


def verificar_en_google(g, consulta=None):
    """g = grupo(...) ya leído; esto corre fuera del candado porque tarda (Google + agente)."""
    clave = g["clave"]
    variaciones = [v["texto"] for v in g["variaciones"]]
    consulta = consulta or f"{g['marca']} {variaciones[0] if variaciones else clave.split('|')[1]} impresora"
    resultados = buscar_google(consulta)
    candidatos, explicacion = preguntar_agente(g["marca"], variaciones, resultados)
    # Anti-alucinación: cada candidato debe aparecer (sin espacios ni guiones) en los resultados reales.
    todo = norma.compacto(" ".join(r["titulo"] + " " + r["texto"] for r in resultados))
    revisados = [{"nombre": sin_espacios_sobrantes(n), "en_google": norma.compacto(n) in todo}
                 for n in candidatos if sin_espacios_sobrantes(n)]
    return {"consulta": consulta, "candidatos": revisados, "explicacion": explicacion,
            "resultados": [{"titulo": r["titulo"], "texto": r["texto"][:200]} for r in resultados]}


# ------------------------------------------------------------------ servidor HTTP

class Manejador(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def responder(self, datos, estado=200, tipo="application/json"):
        cuerpo = datos if isinstance(datos, bytes) else json.dumps(datos, ensure_ascii=False).encode()
        self.send_response(estado)
        self.send_header("Content-Type", tipo + ("; charset=utf-8" if "json" in tipo or "html" in tipo
                                                 or "javascript" in tipo else ""))
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)

    def do_GET(self):
        u = urlparse(self.path)
        p = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/favicon.ico":
                return self.responder(b"", 204, "image/x-icon")
            if u.path in ("/", "/index.html"):
                return self.responder((PAGINA / "index.html").read_bytes(), tipo="text/html")
            if u.path == "/app.js" or (u.path.startswith("/vendor/") and u.path.endswith(".js")
                                         and "/" not in u.path[len("/vendor/"):]):
                return self.responder((PAGINA / u.path.lstrip("/")).read_bytes(), tipo="text/javascript")
            with LOCK:
                c = self.server.c
                if u.path == "/api/resumen":
                    return self.responder(resumen(c))
                if u.path == "/api/filas":
                    return self.responder(lista(c, p.get("q", ""), int(p.get("offset", 0)), int(p.get("limite", 100))))
                if u.path == "/api/grupo":
                    return self.responder(grupo(c, p["clave"]))
            self.responder({"error": "no encontrado"}, 404)
        except Exception as e:  # el error se muestra en la página
            self.responder({"error": str(e)}, 500)

    def do_POST(self):
        largo = int(self.headers.get("Content-Length") or 0)
        d = json.loads(self.rfile.read(largo) or b"{}")
        try:
            c = self.server.c
            if self.path == "/api/google":  # lento: la base no queda bloqueada mientras busca
                with LOCK:
                    g = grupo(c, d["clave"])
                return self.responder(verificar_en_google(g, d.get("consulta")))
            with LOCK:
                if self.path == "/api/loop":
                    return self.responder(loop_automatico(c))
                if self.path == "/api/normalizar":
                    return self.responder(normalizar(c, d["clave"], set(d["llaves"]), d["nombre"],
                                                     d.get("como", "manual")))
                if self.path == "/api/deshacer":
                    return self.responder(deshacer(c))
                if self.path == "/api/exportar":
                    return self.responder(exportar(c))
            self.responder({"error": "no encontrado"}, 404)
        except ValueError as e:
            self.responder({"error": str(e)}, 400)
        except Exception as e:
            self.responder({"error": str(e)}, 500)


class Servidor(ThreadingHTTPServer):
    allow_reuse_address = False  # en Mac, reusar la dirección deja "compartir" el puerto con otra app


def puerto_ocupado(puerto):
    """True si ya hay algo escuchando en ese puerto (IPv4 o IPv6), aunque sea otra aplicación."""
    import socket
    for familia, direccion in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
        try:
            with socket.socket(familia, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                if s.connect_ex((direccion, puerto)) == 0:
                    return True
        except OSError:
            pass
    return False


def respaldar(motivo):
    """Copia datos/web.db a datos/respaldos/ (se guardan los últimos 20). El avance nunca se pierde."""
    if not DB.exists():
        return None
    carpeta = DATOS / "respaldos"
    carpeta.mkdir(exist_ok=True)
    destino = carpeta / f"web-{time.strftime('%Y%m%d-%H%M%S')}-{motivo}.db"
    origen = sqlite3.connect(DB)
    with sqlite3.connect(destino) as copia:
        origen.backup(copia)  # copia consistente aunque la base esté en uso
    origen.close()
    for viejo in sorted(carpeta.glob("web-*.db"))[:-20]:
        viejo.unlink()
    return destino


def main():
    respaldar("al-abrir")
    c = conectar()
    c.execute("create table if not exists meta(k text primary key, v text)")
    version = c.execute("select v from meta where k='algoritmo'").fetchone()
    hechos = c.execute("select count(*) from filas where estado='COMPLETADO'").fetchone()[0]
    vacio = not c.execute("select count(*) from filas").fetchone()[0]
    if "--reimportar" in sys.argv and hechos:
        r = input(f"Hay {hechos} registros normalizados. Recargar los CSV los BORRA de la web "
                  f"(queda un respaldo en datos/respaldos/). Escribe SI para continuar: ")
        if r.strip().upper() != "SI":
            sys.exit("Cancelado: no se recargó nada.")
        print("Respaldo:", respaldar("antes-de-reimportar"))
    if "--reimportar" in sys.argv or vacio or (version is None or version[0] != ALGORITMO) and hechos == 0:
        importar(c)
    elif version is None or version[0] != ALGORITMO:
        print("Aviso: cambió el algoritmo, pero ya hay registros normalizados; no recargo para no perderlos.")
    c.execute("insert or replace into meta values('algoritmo', ?)", (ALGORITMO,))
    c.commit()
    servidor = None
    for puerto in range(PUERTO, PUERTO + 20):  # si el puerto está ocupado (otra app), usa el siguiente libre
        if puerto_ocupado(puerto):
            continue
        try:
            servidor = Servidor(("127.0.0.1", puerto), Manejador)
            break
        except OSError:
            continue
    if not servidor:
        sys.exit(f"No hay puertos libres entre {PUERTO} y {PUERTO + 19}.")
    servidor.c = c
    url = f"http://127.0.0.1:{puerto}"  # 127.0.0.1 y no "localhost": así nunca cae en otra app
    print(f"Normalizador web en {url}  (Control+C para cerrar)")
    if "--sin-navegador" not in sys.argv:
        threading.Timer(1, lambda: webbrowser.open(url)).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nCerrado.")


if __name__ == "__main__":
    main()
