#!/usr/bin/env python3
"""Normalizador de impresoras — herramienta que usa Claude Code para recorrer COMPATIBILITY.

Comandos (todos con: python3 norma.py <comando> ...):
  importar <archivo.csv>        Carga el CSV exportado de FileMaker (ID, Brand, COMPATIBILITY, ImpresoraNormalizada).
  estado                        Cuántos registros hay en cada estado.
  siguiente-lote [--grupos N]   Próximos N grupos pendientes (marca + números) en JSON.
  google "<consulta>"           Busca en Google con Chrome (Playwright) y devuelve los 10 primeros resultados.
  chrome                        Abre el Chrome del normalizador para iniciar sesión en Google / aceptar cookies.
  proponer [archivo|-]          Agente 1 guarda sus decisiones (JSON). El código valida evidencia y regla de oro.
  lote-verificar [--n N]        Propuestas pendientes de verificación, agrupadas por nombre.
  verificar [archivo|-]         Agente 2 aprueba o rechaza (JSON).
  exportar                      Escribe datos/salida/aprobados.csv y revision_humana.csv para importar a FileMaker.
"""
import argparse
import csv
import io
import json
import random
import re
import sqlite3
import sys
import time
import unicodedata
from pathlib import Path
from urllib.parse import quote_plus

BASE = Path(__file__).resolve().parent
DATOS = BASE / "datos"
DB = DATOS / "normalizador.db"
PERFIL_CHROME = DATOS / "perfil-chrome"
SALIDA = DATOS / "salida"

# Pausa entre búsquedas en Google (segundos) para no gatillar el captcha.
PAUSA_MIN, PAUSA_MAX = 12, 25

# FileMaker exporta los saltos de línea dentro de un campo como tabulador vertical (\x0b).
SEPARADORES = re.compile(r"[\x0b\n\r;,|]+")

ESQUEMA = """
create table if not exists registros(
  rid text primary key,            -- ID de FileMaker, o ID#n si el campo traía varias impresoras
  fm_id text, marca_fm text, texto text, normalizada_actual text,
  grupo text,                      -- MARCA|números, la búsqueda "solo números" del flujo
  estado text default 'PENDIENTE', -- PENDIENTE, PROPUESTO, APROBADO, REVISION_HUMANA
  marca text, familia text, modelo text, variante text, nombre text,
  evidencia_titulo text, evidencia_url text, nota text, motivo_verificador text,
  actualizado real);
create index if not exists ix_grupo on registros(grupo);
create index if not exists ix_estado on registros(estado);
create table if not exists busquedas(consulta text primary key, resultados text, fecha real);
create table if not exists meta(k text primary key, v text);
"""


def conectar():
    DATOS.mkdir(exist_ok=True)
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    c.executescript(ESQUEMA)
    return c


def plano(s):
    """Minúsculas, sin acentos y con espacios simples: para comparar textos."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", s).strip().lower()


def solo_digitos(s):
    return re.sub(r"\D", "", s or "")


def clave_grupo(marca, texto):
    t = plano(texto).upper()
    numeros = re.findall(r"\d{2,}", t)
    nucleo = numeros[-1] if numeros else re.sub(r"[^A-Z0-9]", "", t)[:12]
    return f"{(marca or 'SIN MARCA').strip().upper()}|{nucleo}"


def leer_csv(ruta):
    crudo = Path(ruta).read_bytes()
    for codificacion in ("utf-8-sig", "mac_roman", "cp1252"):
        try:
            texto = crudo.decode(codificacion)
            break
        except UnicodeDecodeError:
            continue
    # csv acepta \r (Mac antiguo, lo usa FileMaker), \n y \r\n como fin de fila.
    return list(csv.reader(io.StringIO(texto, newline="")))


def leer_json(origen):
    datos = sys.stdin.read() if origen in (None, "-") else Path(origen).read_text(encoding="utf-8")
    datos = json.loads(datos)
    return datos if isinstance(datos, list) else [datos]


def salir_json(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=1))


# ---------------------------------------------------------------- importar / estado

def cmd_importar(a):
    c = conectar()
    nuevos = 0
    for fila in leer_csv(a.archivo):
        if len(fila) < 3 or not fila[0].strip() or fila[0].strip().upper() == "ID":
            continue
        fm_id, marca, compat = fila[0].strip(), fila[1].strip(), fila[2]
        actual = fila[3].strip() if len(fila) > 3 else ""
        piezas = [p.strip() for p in SEPARADORES.split(compat) if p.strip()]
        for i, pieza in enumerate(piezas, 1):
            rid = fm_id if len(piezas) == 1 else f"{fm_id}#{i}"
            cur = c.execute(
                "insert or ignore into registros(rid, fm_id, marca_fm, texto, normalizada_actual, grupo)"
                " values(?,?,?,?,?,?)",
                (rid, fm_id, marca, pieza, actual, clave_grupo(marca, pieza)))
            nuevos += cur.rowcount
    c.commit()
    print(f"Importados {nuevos} registros nuevos.")
    cmd_estado(a)


def cmd_estado(_a):
    c = conectar()
    filas = c.execute("select estado, count(*) n from registros group by estado").fetchall()
    grupos = c.execute("select count(distinct grupo) from registros where estado='PENDIENTE'").fetchone()[0]
    busq = c.execute("select count(*) from busquedas").fetchone()[0]
    salir_json({"registros": {f["estado"]: f["n"] for f in filas},
                "grupos_pendientes": grupos, "busquedas_google_hechas": busq})


# ---------------------------------------------------------------- agente 1

def cmd_siguiente_lote(a):
    c = conectar()
    grupos = [f[0] for f in c.execute(
        "select grupo from registros where estado='PENDIENTE' group by grupo order by grupo limit ?",
        (a.grupos,))]
    lote = []
    for g in grupos:
        pendientes = c.execute(
            "select rid, texto, normalizada_actual from registros where grupo=? and estado='PENDIENTE'"
            " order by rid limit ?", (g, a.max_registros)).fetchall()
        total = c.execute("select count(*) from registros where grupo=? and estado='PENDIENTE'", (g,)).fetchone()[0]
        ya = [f[0] for f in c.execute(
            "select distinct nombre from registros where grupo=? and estado='APROBADO'", (g,))]
        lote.append({
            "grupo": g,
            "pendientes_total": total,
            "registros": [dict(f) for f in pendientes],
            "ya_aprobados_en_este_grupo": ya,
        })
    salir_json(lote)


def evidencia_existe(c, titulo):
    """True si el título citado aparece de verdad en algún resultado de Google guardado."""
    buscado = plano(titulo)
    if len(buscado) < 6:
        return False
    for (res,) in c.execute("select resultados from busquedas"):
        for r in json.loads(res):
            if buscado in plano(r.get("titulo")) or buscado in plano(r.get("texto")):
                return True
    return False


def cmd_proponer(a):
    c = conectar()
    resumen = {"PROPUESTO": 0, "REVISION_HUMANA": 0, "ignorados": []}
    for d in leer_json(a.archivo):
        rids = d.get("rids") or ([d["rid"]] if d.get("rid") else [])
        for rid in rids:
            fila = c.execute("select texto, estado from registros where rid=?", (rid,)).fetchone()
            if not fila or fila["estado"] != "PENDIENTE":
                resumen["ignorados"].append(rid)
                continue
            estado, nota = "PROPUESTO", d.get("nota") or ""
            if d.get("estado") != "OK":
                estado = "REVISION_HUMANA"
            elif not d.get("nombre") or not d.get("modelo"):
                estado, nota = "REVISION_HUMANA", "Falta nombre o modelo. " + nota
            elif solo_digitos(d["modelo"]) not in solo_digitos(fila["texto"]):
                estado = "REVISION_HUMANA"
                nota = (f"Regla de oro: el modelo '{d['modelo']}' tiene números que no están en "
                        f"'{fila['texto']}'. " + nota)
            elif d.get("evidencia_titulo") and not evidencia_existe(c, d["evidencia_titulo"]):
                estado = "REVISION_HUMANA"
                nota = "La evidencia citada no aparece en los resultados reales de Google. " + nota
            c.execute(
                "update registros set estado=?, marca=?, familia=?, modelo=?, variante=?, nombre=?,"
                " evidencia_titulo=?, evidencia_url=?, nota=?, actualizado=? where rid=?",
                (estado, d.get("marca"), d.get("familia"), d.get("modelo"), d.get("variante"),
                 d.get("nombre"), d.get("evidencia_titulo"), d.get("evidencia_url"), nota.strip(),
                 time.time(), rid))
            resumen[estado] += 1
    c.commit()
    salir_json(resumen)


# ---------------------------------------------------------------- agente 2

def cmd_lote_verificar(a):
    c = conectar()
    nombres = [f[0] for f in c.execute(
        "select nombre from registros where estado='PROPUESTO' group by nombre order by min(actualizado) limit ?",
        (a.n,))]
    salida = []
    for nombre in nombres:
        filas = c.execute(
            "select rid, texto, marca, familia, modelo, variante, evidencia_titulo, evidencia_url, nota"
            " from registros where estado='PROPUESTO' and nombre=?", (nombre,)).fetchall()
        f0 = filas[0]
        salida.append({
            "nombre": nombre, "marca": f0["marca"], "familia": f0["familia"],
            "modelo": f0["modelo"], "variante": f0["variante"],
            "evidencia_titulo": f0["evidencia_titulo"], "evidencia_url": f0["evidencia_url"],
            "registros": [{"rid": f["rid"], "texto": f["texto"]} for f in filas],
        })
    salir_json(salida)


def cmd_verificar(a):
    c = conectar()
    resumen = {"APROBADO": 0, "REVISION_HUMANA": 0, "ignorados": []}
    for d in leer_json(a.archivo):
        rids = d.get("rids") or ([d["rid"]] if d.get("rid") else [])
        decision = "APROBADO" if d.get("decision") == "APROBADO" else "REVISION_HUMANA"
        motivo = d.get("motivo") or ""
        if (decision == "APROBADO" and d.get("evidencia_titulo")
                and not evidencia_existe(c, d["evidencia_titulo"])):
            decision = "REVISION_HUMANA"
            motivo = "La evidencia del verificador no aparece en los resultados reales de Google. " + motivo
        for rid in rids:
            fila = c.execute("select estado from registros where rid=?", (rid,)).fetchone()
            if not fila or fila["estado"] != "PROPUESTO":
                resumen["ignorados"].append(rid)
                continue
            c.execute("update registros set estado=?, motivo_verificador=?, actualizado=? where rid=?",
                      (decision, motivo.strip(), time.time(), rid))
            resumen[decision] += 1
    c.commit()
    salir_json(resumen)


# ---------------------------------------------------------------- Google con Playwright

JS_RESULTADOS = """() => {
  const out = [], vistos = new Set();
  for (const h3 of document.querySelectorAll('#search h3, #rso h3')) {
    const a = h3.closest('a');
    if (!a || !a.href || vistos.has(a.href)) continue;
    vistos.add(a.href);
    let bloque = a;
    for (let i = 0; i < 6 && bloque.parentElement; i++) {
      bloque = bloque.parentElement;
      if ((bloque.innerText || '').length > h3.innerText.length + 80) break;
    }
    out.push({titulo: h3.innerText.trim(), url: a.href,
              texto: (bloque.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400)});
    if (out.length >= 10) break;
  }
  return out;
}"""


def abrir_chrome(p):
    PERFIL_CHROME.mkdir(parents=True, exist_ok=True)
    ctx = p.chromium.launch_persistent_context(str(PERFIL_CHROME), channel="chrome", headless=False)
    return ctx, (ctx.pages[0] if ctx.pages else ctx.new_page())


def hay_captcha(page):
    if "/sorry/" in page.url:
        return True
    if page.query_selector("#captcha-form, iframe[src*='recaptcha']"):
        return True
    cuerpo = plano(page.inner_text("body")[:3000]) if page.query_selector("body") else ""
    return "unusual traffic" in cuerpo or "trafico inusual" in cuerpo


def esperar_captcha(page):
    if not hay_captcha(page):
        return
    print("Google pide verificación: resuélvela en la ventana de Chrome (espero hasta 10 minutos)...",
          file=sys.stderr)
    fin = time.time() + 600
    while time.time() < fin:
        page.wait_for_timeout(3000)
        if not hay_captcha(page) and page.query_selector("#search, #rso"):
            return
    sys.exit("Captcha sin resolver: detén el loop y vuelve a intentar más tarde.")


def esperar_turno(c):
    fila = c.execute("select v from meta where k='ultima_busqueda'").fetchone()
    if fila:
        falta = float(fila[0]) + random.uniform(PAUSA_MIN, PAUSA_MAX) - time.time()
        if falta > 0:
            time.sleep(falta)


def cmd_google(a):
    consulta = a.consulta.strip()
    c = conectar()
    guardada = c.execute("select resultados from busquedas where consulta=?", (consulta,)).fetchone()
    if guardada:
        salir_json({"consulta": consulta, "desde_cache": True, "resultados": json.loads(guardada[0])})
        return
    from playwright.sync_api import sync_playwright
    esperar_turno(c)
    with sync_playwright() as p:
        ctx, page = abrir_chrome(p)
        page.goto("https://www.google.com/search?hl=es&num=10&q=" + quote_plus(consulta),
                  wait_until="domcontentloaded")
        esperar_captcha(page)
        page.wait_for_timeout(1500)
        resultados = page.evaluate(JS_RESULTADOS)
        ctx.close()
    c.execute("insert or replace into busquedas values(?,?,?)",
              (consulta, json.dumps(resultados, ensure_ascii=False), time.time()))
    c.execute("insert or replace into meta values('ultima_busqueda', ?)", (str(time.time()),))
    c.commit()
    salir_json({"consulta": consulta, "desde_cache": False, "resultados": resultados})


def cmd_chrome(_a):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        ctx, page = abrir_chrome(p)
        page.goto("https://www.google.com/?hl=es")
        print("Chrome abierto. Acepta las cookies e inicia sesión en Google si quieres; "
              "luego cierra la ventana.")
        page.wait_for_event("close", timeout=0)
        ctx.close()


# ---------------------------------------------------------------- exportar

def cmd_exportar(_a):
    c = conectar()
    SALIDA.mkdir(parents=True, exist_ok=True)
    columnas = {
        "aprobados.csv": ("select fm_id, rid, texto, nombre, marca, familia, modelo, variante"
                          " from registros where estado='APROBADO' order by fm_id, rid"),
        "revision_humana.csv": ("select fm_id, rid, texto, normalizada_actual, nombre as propuesta,"
                                " nota, motivo_verificador from registros"
                                " where estado='REVISION_HUMANA' order by grupo, rid"),
    }
    for archivo, sql in columnas.items():
        cur = c.execute(sql)
        with open(SALIDA / archivo, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow([d[0] for d in cur.description])
            filas = cur.fetchall()
            w.writerows(filas)
        print(f"{SALIDA / archivo}: {len(filas)} filas")


def main():
    ap = argparse.ArgumentParser(description="Normalizador de impresoras")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("importar"); s.add_argument("archivo"); s.set_defaults(f=cmd_importar)
    sub.add_parser("estado").set_defaults(f=cmd_estado)
    s = sub.add_parser("siguiente-lote")
    s.add_argument("--grupos", type=int, default=5)
    s.add_argument("--max-registros", type=int, default=60)
    s.set_defaults(f=cmd_siguiente_lote)
    s = sub.add_parser("google"); s.add_argument("consulta"); s.set_defaults(f=cmd_google)
    sub.add_parser("chrome").set_defaults(f=cmd_chrome)
    s = sub.add_parser("proponer"); s.add_argument("archivo", nargs="?"); s.set_defaults(f=cmd_proponer)
    s = sub.add_parser("lote-verificar"); s.add_argument("--n", type=int, default=15)
    s.set_defaults(f=cmd_lote_verificar)
    s = sub.add_parser("verificar"); s.add_argument("archivo", nargs="?"); s.set_defaults(f=cmd_verificar)
    sub.add_parser("exportar").set_defaults(f=cmd_exportar)
    a = ap.parse_args()
    a.f(a)


if __name__ == "__main__":
    main()
