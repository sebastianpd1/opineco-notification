// Normalizador de impresoras — React 18 sin compilación: React, ReactDOM y htm vienen en web/vendor/
// (copiados al proyecto, así la página funciona sin internet).
const { useState, useEffect, useCallback } = React;
const { createRoot } = ReactDOM;

const html = htm.bind(React.createElement);
const POR_PAGINA = 100;

async function api(ruta, datos) {
  const r = await fetch(ruta, datos === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(datos),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || "Error");
  return j;
}

function App() {
  const [resumen, setResumen] = useState(null);
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [lista, setLista] = useState({ total: 0, filas: [] });
  const [pestana, setPestana] = useState("PENDIENTE");
  const [clave, setClave] = useState(null);
  const [principal, setPrincipal] = useState(null);  // la impresora en la que se hizo clic
  const [toast, setToast] = useState("");
  const [ocupado, setOcupado] = useState(false);

  const avisar = (m) => { setToast(m); setTimeout(() => setToast(""), 3500); };
  const [fm, setFm] = useState(null);

  const cargar = useCallback(async () => {
    setResumen(await api("/api/resumen"));
    setLista(await api(`/api/filas?estado=${pestana}&q=${encodeURIComponent(q)}&offset=${offset}&limite=${POR_PAGINA}`));
  }, [q, offset, pestana]);

  useEffect(() => { cargar().catch((e) => avisar(e.message)); }, [cargar]);

  // Estado de FileMaker cada 5 s; si termina una carga, se refresca la lista.
  useEffect(() => {
    let cargando = false;
    const revisar = async () => {
      try {
        const e = await api("/api/fm");
        if (cargando && !e.carga.activa) { cargar(); if (e.carga.error) avisar(e.carga.error); }
        cargando = e.carga.activa;
        setFm(e);
      } catch (_) { setFm({ ok: false, detalle: "La página perdió contacto con el programa", carga: {} }); }
    };
    revisar();
    const t = setInterval(revisar, 5000);
    return () => clearInterval(t);
  }, [cargar]);

  const accion = async (ruta, mensaje) => {
    setOcupado(true);
    try { const r = await api(ruta, {}); avisar(mensaje(r)); await cargar(); }
    catch (e) { avisar(e.message); }
    setOcupado(false);
  };

  return html`
    <header>
      <h1>Normalizador de impresoras</h1>
      ${resumen && html`
        <span class="stat">Pendientes <b>${resumen.pendientes.toLocaleString("es-CL")}</b></span>
        <span class="stat">Completados <b>${resumen.completados.toLocaleString("es-CL")}</b></span>
        <span class="stat">Grupos por revisar <b>${resumen.grupos_pendientes.toLocaleString("es-CL")}</b></span>`}
      <${EstadoFM} fm=${fm} avisar=${avisar} />
      <button disabled=${ocupado || !resumen?.puede_deshacer}
        onClick=${() => accion("/api/deshacer", (r) => r.mensaje)}>Deshacer</button>
      <button disabled=${ocupado}
        onClick=${() => accion("/api/exportar", (r) => `Exportados ${r.registros} registros a ${r.archivo}`)}>Exportar CSV</button>
      <input type="text" placeholder="Buscar SKU o impresora…" value=${q}
        onInput=${(e) => { setQ(e.target.value); setOffset(0); }} style=${{ marginLeft: "auto", width: "240px" }} />
    </header>
    <main>
      <section class="lista">
        <div class="pestanas">
          ${[["PENDIENTE", "Pendientes", resumen?.pendientes], ["COMPLETADO", "Completados", resumen?.completados]].map(([k, t, n]) => html`
            <button key=${k} class=${"pestana" + (pestana === k ? " activa" : "")}
              onClick=${() => { setPestana(k); setOffset(0); }}>
              ${t}${n !== undefined ? ` (${n.toLocaleString("es-CL")})` : ""}</button>`)}
        </div>
        ${pestana === "PENDIENTE" ? html`
          <table>
            <thead><tr><th>SKU</th><th>Impresora</th><th></th></tr></thead>
            <tbody>
              ${lista.filas.map((f) => html`
                <tr key=${f.id} class=${f.clave === clave ? "activa" : ""}>
                  <td class="sku">${f.sku}</td>
                  <td>${f.texto}</td>
                  <td><button class="primario" onClick=${() => { setClave(f.clave); setPrincipal(f.texto); }}>Verificar</button></td>
                </tr>`)}
            </tbody>
          </table>` : html`
          <table>
            <thead><tr><th>SKU</th><th>Impresora original</th><th>Normalizada como</th><th>Cómo</th><th>FileMaker</th><th></th></tr></thead>
            <tbody>
              ${lista.filas.map((f) => html`
                <tr key=${f.id}>
                  <td class="sku">${f.sku}</td>
                  <td>${f.texto}</td>
                  <td><b>${f.nombre}</b></td>
                  <td class="nota">${{ auto: "automático", manual: "manual", google: "Google" }[f.como] || f.como}</td>
                  <td class="nota">${envioFM(f)}</td>
                  <td><button title="El grupo vuelve a Pendientes para corregirlo"
                    onClick=${async () => {
                      try { const r = await api("/api/reabrir", { clave: f.clave }); avisar(r.mensaje); await cargar(); }
                      catch (e) { avisar(e.message); }
                    }}>Reabrir</button></td>
                </tr>`)}
            </tbody>
          </table>`}
        ${lista.filas.length === 0 && html`<div class="vacio">No hay ${pestana === "PENDIENTE" ? "pendientes" : "completados"}${q ? " con esa búsqueda" : ""}.</div>`}
        <div class="paginas">
          <button disabled=${offset === 0} onClick=${() => setOffset(Math.max(0, offset - POR_PAGINA))}>‹ Anteriores</button>
          <span>${lista.total ? `${offset + 1}–${Math.min(offset + POR_PAGINA, lista.total)} de ${lista.total.toLocaleString("es-CL")}` : ""}</span>
          <button disabled=${offset + POR_PAGINA >= lista.total} onClick=${() => setOffset(offset + POR_PAGINA)}>Siguientes ›</button>
        </div>
      </section>
      <section class="panel">
        ${clave
          ? html`<${Grupo} clave=${clave} principal=${principal} avisar=${avisar}
                   alTerminar=${async (quedan) => {
                     await cargar();
                     if (!quedan) setClave(null);
                   }} />`
          : html`<div class="vacio">Toca <b>Verificar</b> en una impresora para ver sus coincidencias.</div>`}
      </section>
    </main>
    ${toast && html`<div class="toast">${toast}</div>`}
  `;
}

function envioFM(f) {
  if (f.como === "auto") return "—";
  if (!f.fm_recid) return html`<span title="Esta lista vino de CSV: recárgala desde FileMaker">sin FileMaker</span>`;
  if (f.fm_error) return html`<span class="error" title=${f.fm_error}>⚠ error</span>`;
  return f.fm_valor === f.nombre ? html`<span class="ok">✓ escrito</span>` : "⏳ por enviar";
}

function EstadoFM({ fm, avisar }) {
  if (!fm) return null;
  const post = async (ruta) => { try { avisar((await api(ruta, {})).mensaje); } catch (e) { avisar(e.message); } };
  const color = fm.ok === true ? "verde" : fm.ok === false ? "rojo" : "gris";
  const texto = fm.ok === true ? "FileMaker OK" : fm.ok === false ? "FileMaker sin respuesta" : "FileMaker sin configurar";
  return html`
    <span class=${"fm " + color} title=${fm.detalle || ""}>● ${texto}</span>
    ${fm.carga?.activa
      ? html`<span class="stat">${fm.carga.mensaje}</span>`
      : fm.configurado && html`<button disabled=${!fm.ok} title="Trae lo nuevo de FileMaker; lo ya normalizado se conserva"
          onClick=${() => post("/api/fm/recargar")}>Recargar desde FileMaker</button>`}
    ${fm.por_enviar > 0 && html`<span class="stat">Por enviar <b>${fm.por_enviar}</b></span>`}
    ${fm.errores > 0 && html`<button class="error" title="Envíos que FileMaker rechazó" onClick=${() => post("/api/fm/reintentar")}>
        ⚠ ${fm.errores} con error · Reintentar</button>`}
  `;
}

function Grupo({ clave, principal, avisar, alTerminar }) {
  const [g, setG] = useState(null);
  const [marcadas, setMarcadas] = useState({});
  const [nombre, setNombre] = useState("");
  const [consulta, setConsulta] = useState("");
  const [google, setGoogle] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [error, setError] = useState("");

  const cargarGrupo = useCallback(async () => {
    const d = await api(`/api/grupo?clave=${encodeURIComponent(clave)}`);
    // La principal (la que se tocó en la lista) va primera.
    d.variaciones.sort((a, b) => (b.llave === principal) - (a.llave === principal));
    setG(d);
    setMarcadas(Object.fromEntries(d.variaciones.map((v) => [v.llave, true])));
    return d;
  }, [clave, principal]);

  useEffect(() => {
    setNombre(""); setGoogle(null); setError(""); setG(null);
    cargarGrupo().then((d) => {
      setConsulta(`${d.marca} ${d.variaciones[0]?.texto || ""} impresora`.trim());
    }).catch((e) => setError(e.message));
  }, [clave, principal, cargarGrupo]);

  if (!g) return html`<div class="vacio">${error || "Cargando…"}</div>`;

  const llaves = g.variaciones.filter((v) => marcadas[v.llave]).map((v) => v.llave);
  const cuantos = g.variaciones.filter((v) => marcadas[v.llave]).reduce((s, v) => s + v.cantidad, 0);

  const normalizarComo = async (valor, como) => {
    if (!llaves.length) return avisar("Marca al menos una variación.");
    try {
      const r = await api("/api/normalizar", { clave, llaves, nombre: valor, como });
      avisar(`${r.registros} registros normalizados como “${r.nombre}”`);
      const d = await cargarGrupo();
      setNombre(""); setGoogle(null);
      setConsulta(`${d.marca} ${d.variaciones[0]?.texto || ""} impresora`.trim());
      await alTerminar(d.variaciones.length);
    } catch (e) { avisar(e.message); }
  };

  const buscarGoogle = async () => {
    setBuscando(true); setError(""); setGoogle(null);
    try {
      const r = await api("/api/google", { clave, consulta });
      setGoogle(r);
      setNombre(r.candidatos.map((c) => c.nombre).join(", "));
    } catch (e) { setError(e.message); }
    setBuscando(false);
  };

  return html`
    <h2>${g.marca} · ${clave.split("|")[1]}</h2>

    <div class="caja">
      <div class="fila-edit">
        <input type="text" value=${nombre} placeholder="Nombre normalizado (puedes escribirlo o corregirlo)"
          onInput=${(e) => setNombre(e.target.value)} />
        <button class="verde" disabled=${!nombre.trim()} onClick=${() => normalizarComo(nombre, google ? "google" : "manual")}>
          Normalizar como este</button>
      </div>
      <div class="nota">Se aplica a las variaciones marcadas (${cuantos} registros).
        Si Google trae varios separados por coma, deja uno solo o toca uno de abajo.</div>
      ${google && html`
        <div class="chips">
          ${google.candidatos.map((c) => html`
            <span class=${"chip " + (c.en_google ? "ok" : "dudoso")} onClick=${() => setNombre(c.nombre)}
              title=${c.en_google ? "Aparece en los resultados de Google" : "No aparece tal cual en los resultados: revísalo"}>
              ${c.en_google ? "✓ " : "⚠ "}${c.nombre}</span>`)}
        </div>
        ${google.explicacion && html`<div class="nota" style=${{ marginTop: "6px" }}>${google.explicacion}</div>`}
        <details style=${{ marginTop: "6px" }}><summary class="nota">Resultados de Google (${google.resultados.length})</summary>
          <ol class="resultados">${google.resultados.map((r, i) => html`<li key=${i}><b>${r.titulo}</b> — ${r.texto}</li>`)}</ol>
        </details>`}
      ${g.ya_normalizados.length > 0 && html`
        <div class="nota" style=${{ marginTop: "8px" }}>Ya normalizados en este grupo:</div>
        <div class="chips">${g.ya_normalizados.map((n) => html`<span class="chip" onClick=${() => setNombre(n)}>${n}</span>`)}</div>`}
    </div>

    <div class="caja">
      <div class="fila-edit">
        <input type="text" value=${consulta} onInput=${(e) => setConsulta(e.target.value)} />
        <button class="primario" disabled=${buscando} onClick=${buscarGoogle}>
          ${buscando ? "Buscando…" : "Buscar y verificar en Google"}</button>
      </div>
      <div class="nota">${buscando
        ? "Se abre Chrome, busca y un agente revisa los resultados (30–90 s). Si Google pide captcha, resuélvelo en esa ventana."
        : "El agente deja arriba lo que encuentre; tú lo corriges y apruebas."}</div>
      ${error && html`<div class="error">${error}</div>`}
    </div>

    <div>
      ${g.variaciones.length === 0 && html`<div class="vacio">Este grupo ya no tiene pendientes.</div>`}
      ${g.variaciones.map((v) => html`
        <div class="var" key=${v.llave}>
          <input type="checkbox" checked=${!!marcadas[v.llave]}
            title="Desmarca si esta variación es otra impresora"
            onChange=${(e) => setMarcadas({ ...marcadas, [v.llave]: e.target.checked })} />
          <div class="txt">
            ${v.llave === principal && html`<span class="principal" title="La que estás verificando">★ </span>`}<span class="nombre">${v.texto}</span><span class="mas">+${v.cantidad}</span>
            <div class="skus">${v.skus.join(", ")}${v.total_skus > v.skus.length ? ` y ${v.total_skus - v.skus.length} más` : ""}${" · "}${v.origenes.join(", ").toLowerCase()}</div>
          </div>
          <button title="Deja marcada solo esta variación (las otras quedan pendientes, juntas entre sí)"
            onClick=${() => setMarcadas(Object.fromEntries(g.variaciones.map((x) => [x.llave, x.llave === v.llave])))}>Solo esta</button>
          <button title="Copiar al campo de arriba para corregirlo" onClick=${() => setNombre(v.texto)}>✎</button>
          <button class="verde" onClick=${() => normalizarComo(v.texto, "manual")}>Normalizar como este</button>
        </div>`)}
    </div>
  `;
}

createRoot(document.getElementById("app")).render(html`<${App} />`);
