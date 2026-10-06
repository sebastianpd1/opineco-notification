"""Conexión con FileMaker Server por XML Web Publishing (/fmi/xml/fmresultset.xml).

Configuración en datos/filemaker.env (no va a git; copiar desde filemaker.env.ejemplo):
  FM_HOST, FM_DB, FM_USER, FM_PASS y, si cambian, layouts y nombres de campos.
"""
import base64
import html
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class FMCaido(Exception):
    """FileMaker no responde de verdad (red, timeout, HTTP de error o 200 vacío): reintentar más tarde."""

ARCHIVO = Path(__file__).resolve().parent / "datos" / "filemaker.env"
POR_DEFECTO = {
    "FM_DB": "MultiData",
    "FM_LAYOUT_INVENTARIO": "INVENTARIO",
    "FM_CAMPO_INVENTARIO_ITEM": "Item",
    "FM_CAMPO_INVENTARIO_MARCA": "Marca",
    "FM_CAMPO_NORMALIZADA_MARCA": "Marca",
    "FM_CAMPO_COMPATIBILITY_SKU": "InventoryItem",
    "FM_CAMPO_COMPATIBILITY_MARCA": "Brand",
    "FM_POR_PAGINA": "1000",
    "FM_LAYOUT_NORMALIZADA": "COMPATIBILIDADNORMALIZADA",
    "FM_CAMPO_NORMALIZADA_SKU": "SKU",
    "FM_CAMPO_NORMALIZADA_IMPRESORA": "Impresora",
    "FM_LAYOUT_COMPATIBILITY": "COMPATIBILITY",
    "FM_CAMPO_COMPATIBILITY_ID": "ID",
    "FM_CAMPO_COMPATIBILITY_IMPRESORA": "Printer",
    "FM_TIMEOUT": "15",
}


def config():
    c = dict(POR_DEFECTO)
    if ARCHIVO.exists():
        for linea in ARCHIVO.read_text(encoding="utf-8").splitlines():
            linea = linea.strip()
            if linea and not linea.startswith("#") and "=" in linea:
                k, v = linea.split("=", 1)
                c[k.strip()] = v.strip().strip('"').strip("'")
    return c


def configurado():
    c = config()
    return all(c.get(k) for k in ("FM_HOST", "FM_DB", "FM_USER", "FM_PASS"))


def llamar(layout, partes):
    """partes: lista de (nombre, valor) ya en orden; la acción (-find, -edit...) va al final con valor None.
    Cada valor se codifica por separado (espacios, &, comillas o tildes rompen la URL si no)."""
    c = config()
    query = [f"-db={urllib.parse.quote(c['FM_DB'])}", f"-lay={urllib.parse.quote(layout)}"]
    for nombre, valor in partes:
        query.append(nombre if valor is None else f"{urllib.parse.quote(nombre)}={urllib.parse.quote(str(valor))}")
    url = f"{c['FM_HOST'].rstrip('/')}/fmi/xml/fmresultset.xml?" + "&".join(query)
    pedido = urllib.request.Request(url)
    clave = base64.b64encode(f"{c['FM_USER']}:{c['FM_PASS']}".encode()).decode()
    pedido.add_header("Authorization", f"Basic {clave}")
    try:
        with urllib.request.urlopen(pedido, timeout=float(c["FM_TIMEOUT"])) as r:
            status, xml = r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise FMCaido(f"HTTP {e.code}" + (" (usuario o clave incorrectos)" if e.code == 401 else ""))
    except Exception as e:  # red, DNS, timeout
        raise FMCaido(f"Sin conexión: {e}")
    if not xml.strip():
        raise FMCaido(f"HTTP {status} sin datos (respuesta vacía)")
    if "<fmresultset" not in xml:
        raise FMCaido(f"HTTP {status}: la respuesta no es de FileMaker")
    return status, xml


def codigo_error(xml):
    m = re.search(r'<error code="(\d+)"', xml)
    return m.group(1) if m else None  # "0" = OK, "401" = 0 registros (no es falla)


def registros(xml):
    filas = []
    for cabecera, cuerpo in re.findall(r"<record ([^>]*)>(.*?)</record>", xml, re.S):
        campos = {k: html.unescape(v) for k, v in
                  re.findall(r'<field name="([^"]+)"><data>(.*?)</data>', cuerpo, re.S)}
        campos["_recid"] = re.search(r'record-id="(\d+)"', cabecera).group(1)
        filas.append(campos)
    return filas


def estado():
    """Como el hub: bien solo si responde 200 CON contenido, y además es XML de FileMaker sin error.
    A veces FileMaker responde 200 con el cuerpo vacío: eso cuenta como caído."""
    if not configurado():
        return {"ok": None, "detalle": "Falta configurar datos/filemaker.env", "fecha": time.time()}
    inicio = time.time()
    try:
        _, xml = llamar(config()["FM_LAYOUT_NORMALIZADA"], [("-findany", None)])
    except FMCaido as e:
        return {"ok": False, "detalle": str(e), "fecha": time.time()}
    codigo = codigo_error(xml)
    if codigo not in ("0", "401"):
        return {"ok": False, "detalle": f"FileMaker respondió error {codigo}", "fecha": time.time()}
    return {"ok": True, "detalle": f"Responde en {int((time.time() - inicio) * 1000)} ms", "fecha": time.time()}


def buscar(layout, campo, criterio):
    _, xml = llamar(layout, [(campo, criterio), ("-find", None)])
    codigo = codigo_error(xml)
    if codigo == "401":
        return []
    if codigo != "0":
        raise RuntimeError(f"FileMaker: error {codigo} al buscar {campo}={criterio}")
    return registros(xml)


def editar(layout, recid, campo, valor):
    _, xml = llamar(layout, [(campo, valor), ("-recid", recid), ("-edit", None)])
    codigo = codigo_error(xml)
    if codigo != "0":
        raise RuntimeError(f"FileMaker: error {codigo} al editar el registro {recid}")


def traer_todo(layout, campos, progreso=None):
    """Trae TODOS los registros del layout, por páginas (-findall con -max/-skip).
    Antes confirma que los campos existen en el layout (si no, FileMaker los ignora en silencio)."""
    por_pagina = int(config()["FM_POR_PAGINA"])
    salida, saltar, total = [], 0, None
    while total is None or saltar < total:
        _, xml = llamar(layout, [("-max", por_pagina), ("-skip", saltar), ("-findall", None)])
        codigo = codigo_error(xml)
        if codigo == "401":
            return salida
        if codigo != "0":
            raise RuntimeError(f"FileMaker: error {codigo} al leer el layout {layout}")
        if total is None:
            definidos = set(re.findall(r'<field-definition [^>]*name="([^"]+)"', xml))
            faltan = [c for c in campos if c not in definidos]
            if faltan:
                raise RuntimeError(f"El layout {layout} no tiene los campos {', '.join(faltan)}. "
                                   f"Campos que sí tiene: {', '.join(sorted(definidos))}")
            m = re.search(r'<resultset count="(\d+)"', xml)
            total = int(m.group(1)) if m else 0
        pagina = registros(xml)
        if not pagina:
            break
        salida += pagina
        saltar += len(pagina)
        if progreso:
            progreso(layout, len(salida), total)
    return salida
