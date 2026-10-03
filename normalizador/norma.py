#!/usr/bin/env python3
"""Normalizador de impresoras — herramienta que usa Claude Code para normalizar compatibilidades.

Comandos (todos con: python3 norma.py <comando> ...):
  importar --inventario X --normalizada Y --compatibilidad Z
                                Carga los 3 CSV de FileMaker (ver README). SKU con normalizada usan esa;
                                el resto, COMPATIBILITY.
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
  rid text primary key,            -- N:<sku>:<n> (normalizada) o C:<ID>[#n] (COMPATIBILITY)
  origen text,                     -- NORMALIZADA o COMPATIBILITY
  sku text, fm_id text, marca_fm text, nro_parte text, categoria text, texto text,
  grupo text,                      -- MARCA|números, la búsqueda "solo números" del flujo
  estado text default 'PENDIENTE', -- PENDIENTE, PROPUESTO, APROBADO, REVISION_HUMANA
  marca text, familia text, modelo text, variante text, nombre text,
  evidencia_titulo text, evidencia_url text, nota text, motivo_verificador text,
  actualizado real);
create index if not exists ix_grupo on registros(grupo, estado);
create index if not exists ix_estado on registros(estado);
create index if not exists ix_nombre on registros(nombre, estado);
-- Texto crudo de COMPATIBILITY de todos los SKU: sirve para contrastar la normalizada (que tuvo alucinaciones).
create table if not exists compat_crudo(sku text, texto text);
create index if not exists ix_crudo on compat_crudo(sku);
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


def nucleo(texto):
    t = plano(texto).upper()
    numeros = re.findall(r"\d{2,}", t)
    return numeros[-1] if numeros else re.sub(r"[^A-Z0-9]", "", t)[:12]


def clave_grupo(marca, texto):
    return f"{(marca or 'SIN MARCA').strip().upper()}|{nucleo(texto)}"


def leer_csv(ruta):
    crudo = Path(ruta).read_bytes()
    for codificacion in ("utf-8-sig", "mac_roman", "cp1252"):
        try:
            texto = crudo.decode(codificacion)
            break
        except UnicodeDecodeError:
            continue
    # csv acepta \r (Mac antiguo, lo usa FileMaker), \n y \r\n como fin de fila.
    filas = [f for f in csv.reader(io.StringIO(texto, newline="")) if any(x.strip() for x in f)]
    # FileMaker no exporta encabezados en CSV; si alguien los dejó, se saltan.
    if filas and filas[0][0].strip().upper() in ("ID", "SKU", "ITEM"):
        filas = filas[1:]
    return filas


def celda(fila, i):
    return fila[i].strip() if len(fila) > i else ""


def piezas(texto):
    return [p.strip() for p in SEPARADORES.split(texto or "") if p.strip()]


def leer_json(origen):
    datos = sys.stdin.read() if origen in (None, "-") else Path(origen).read_text(encoding="utf-8")
    datos = json.loads(datos)
    return datos if isinstance(datos, list) else [datos]


def salir_json(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=1))


# ---------------------------------------------------------------- importar / estado

def cmd_importar(a):
    """Inventario: Item, NroParte, Marca, Categoria.
    Normalizada: SKU, Marca, Impresora, Categoria.
    Compatibility: ID, InventoryItem, Brand, Printer.
    Los SKU con filas en la normalizada se trabajan con ella; el resto con COMPATIBILITY."""
    c = conectar()
    inventario = {}
    for f in leer_csv(a.inventario):
        inventario[celda(f, 0)] = {"nro_parte": celda(f, 1), "marca": celda(f, 2), "categoria": celda(f, 3)}

    normalizada = [f for f in leer_csv(a.normalizada) if celda(f, 0) and celda(f, 2)]
    skus_normalizados = {celda(f, 0) for f in normalizada}
    compat = [f for f in leer_csv(a.compatibilidad) if celda(f, 1) and celda(f, 3)]

    def insertar(rid, origen, sku, fm_id, marca, categoria, texto):
        inv = inventario.get(sku, {})
        marca = marca or inv.get("marca", "")
        cur = c.execute(
            "insert or ignore into registros(rid, origen, sku, fm_id, marca_fm, nro_parte, categoria, texto, grupo)"
            " values(?,?,?,?,?,?,?,?,?)",
            (rid, origen, sku, fm_id, marca, inv.get("nro_parte", ""),
             categoria or inv.get("categoria", ""), texto, clave_grupo(marca, texto)))
        return cur.rowcount

    nuevos = {"NORMALIZADA": 0, "COMPATIBILITY": 0}
    vistos = {}
    for f in normalizada:
        sku = celda(f, 0)
        for texto in piezas(celda(f, 2)):
            vistos[sku] = vistos.get(sku, 0) + 1
            nuevos["NORMALIZADA"] += insertar(f"N:{sku}:{vistos[sku]}", "NORMALIZADA", sku, "",
                                              celda(f, 1), celda(f, 3), texto)
    c.execute("delete from compat_crudo")
    for f in compat:
        fm_id, sku = celda(f, 0), celda(f, 1)
        partes = piezas(celda(f, 3))
        for i, texto in enumerate(partes, 1):
            c.execute("insert into compat_crudo values(?,?)", (sku, texto))
            if sku in skus_normalizados:
                continue
            rid = f"C:{fm_id}" if len(partes) == 1 else f"C:{fm_id}#{i}"
            nuevos["COMPATIBILITY"] += insertar(rid, "COMPATIBILITY", sku, fm_id, celda(f, 2), "", texto)
    c.commit()
    sin_inv = len(({celda(f, 0) for f in normalizada} | {celda(f, 1) for f in compat}) - set(inventario))
    salir_json({"registros_nuevos": nuevos, "skus_con_normalizada": len(skus_normalizados),
                "skus_sin_ficha_en_inventario": sin_inv})
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
    """Cada grupo trae los textos distintos (no cada fila): así una decisión cubre todas sus repeticiones."""
    c = conectar()
    grupos = [f[0] for f in c.execute(
        "select grupo from registros where estado='PENDIENTE' group by grupo order by grupo limit ?",
        (a.grupos,))]
    lote = []
    for g in grupos:
        textos = []
        for f in c.execute(
                "select texto, origen, count(*) n, group_concat(distinct sku) skus,"
                " group_concat(distinct categoria) cats, group_concat(distinct nro_parte) partes"
                " from registros where grupo=? and estado='PENDIENTE'"
                " group by texto, origen order by n desc limit ?", (g, a.max_textos)):
            item = {"texto": f["texto"], "origen": f["origen"], "veces": f["n"],
                    "skus": (f["skus"] or "").split(",")[:5],
                    "categorias": (f["cats"] or "").split(",")[:5],
                    "nros_parte": [p for p in (f["partes"] or "").split(",") if p][:5]}
            if f["origen"] == "NORMALIZADA":
                # Lo que decía COMPATIBILITY para esos mismos SKU con los mismos números: contraste anti-alucinación.
                crudos = {r[0] for r in c.execute(
                    f"select distinct texto from compat_crudo where sku in ({','.join('?' * len(item['skus']))})",
                    item["skus"]) if nucleo(r[0]) == g.split("|", 1)[1]}
                item["en_compatibility_original"] = sorted(crudos)[:8]
            textos.append(item)
        ya = [f[0] for f in c.execute(
            "select distinct nombre from registros where grupo=? and estado='APROBADO'", (g,))]
        lote.append({"grupo": g, "textos": textos, "ya_aprobados_en_este_grupo": ya})
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


def rids_de(c, d, estado):
    """Una decisión apunta a registros por 'rids', o por 'grupo' + 'textos' (todas sus repeticiones)."""
    if d.get("rids") or d.get("rid"):
        return d.get("rids") or [d["rid"]]
    if d.get("grupo") and d.get("textos"):
        marcas = ",".join("?" * len(d["textos"]))
        return [r[0] for r in c.execute(
            f"select rid from registros where grupo=? and estado=? and texto in ({marcas})",
            [d["grupo"], estado, *d["textos"]])]
    if d.get("nombre") and estado == "PROPUESTO":
        sql, args = "select rid from registros where nombre=? and estado='PROPUESTO'", [d["nombre"]]
        if d.get("textos"):
            sql += f" and texto in ({','.join('?' * len(d['textos']))})"
            args += d["textos"]
        return [r[0] for r in c.execute(sql, args)]
    return []


def cmd_proponer(a):
    c = conectar()
    resumen = {"PROPUESTO": 0, "REVISION_HUMANA": 0, "sin_registros": []}
    for d in leer_json(a.archivo):
        rids = rids_de(c, d, "PENDIENTE")
        if not rids:
            resumen["sin_registros"].append(d.get("textos") or d.get("rids") or d.get("rid"))
            continue
        for rid in rids:
            fila = c.execute("select texto, estado from registros where rid=?", (rid,)).fetchone()
            if not fila or fila["estado"] != "PENDIENTE":
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
        f0 = c.execute(
            "select marca, familia, modelo, variante, evidencia_titulo, evidencia_url from registros"
            " where estado='PROPUESTO' and nombre=? and evidencia_titulo is not null limit 1", (nombre,)).fetchone() \
            or c.execute("select marca, familia, modelo, variante, evidencia_titulo, evidencia_url from registros"
                         " where estado='PROPUESTO' and nombre=? limit 1", (nombre,)).fetchone()
        textos = [{"texto": f["texto"], "origen": f["origen"], "veces": f["n"], "categorias": f["cats"]}
                  for f in c.execute(
                      "select texto, origen, count(*) n, group_concat(distinct categoria) cats from registros"
                      " where estado='PROPUESTO' and nombre=? group by texto, origen", (nombre,))]
        salida.append({"nombre": nombre, **dict(f0), "textos": textos})
    salir_json(salida)


def cmd_verificar(a):
    c = conectar()
    resumen = {"APROBADO": 0, "REVISION_HUMANA": 0, "sin_registros": []}
    for d in leer_json(a.archivo):
        decision = "APROBADO" if d.get("decision") == "APROBADO" else "REVISION_HUMANA"
        motivo = d.get("motivo") or ""
        if (decision == "APROBADO" and d.get("evidencia_titulo")
                and not evidencia_existe(c, d["evidencia_titulo"])):
            decision = "REVISION_HUMANA"
            motivo = "La evidencia del verificador no aparece en los resultados reales de Google. " + motivo
        rids = rids_de(c, d, "PROPUESTO")
        if not rids:
            resumen["sin_registros"].append(d.get("nombre") or d.get("rids"))
        for rid in rids:
            cur = c.execute("update registros set estado=?, motivo_verificador=?, actualizado=?"
                            " where rid=? and estado='PROPUESTO'", (decision, motivo.strip(), time.time(), rid))
            resumen[decision] += cur.rowcount
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
    consultas = {
        "aprobados.csv": ("select origen, sku, fm_id, texto, nombre, marca, familia, modelo, variante, categoria"
                          " from registros where estado='APROBADO' order by sku, rid"),
        "revision_humana.csv": ("select origen, sku, fm_id, texto, categoria, nombre as propuesta, nota,"
                                " motivo_verificador from registros where estado='REVISION_HUMANA'"
                                " order by grupo, sku"),
    }
    for archivo, sql in consultas.items():
        cur = c.execute(sql)
        filas = cur.fetchall()
        with open(SALIDA / archivo, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow([d[0] for d in cur.description])
            w.writerows(filas)
        print(f"{SALIDA / archivo}: {len(filas)} filas")


def main():
    ap = argparse.ArgumentParser(description="Normalizador de impresoras")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("importar")
    s.add_argument("--inventario", required=True)
    s.add_argument("--normalizada", required=True)
    s.add_argument("--compatibilidad", required=True)
    s.set_defaults(f=cmd_importar)
    sub.add_parser("estado").set_defaults(f=cmd_estado)
    s = sub.add_parser("siguiente-lote")
    s.add_argument("--grupos", type=int, default=5)
    s.add_argument("--max-textos", type=int, default=40)
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
