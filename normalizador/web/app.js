// Normalizador de impresoras — React 18 sin compilación: React, ReactDOM y htm vienen en web/vendor/
// (copiados al proyecto, así la página funciona sin internet).
const { useState, useEffect, useCallback, useRef } = React;
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
  const [version, setVersion] = useState(0);         // fuerza recargar el panel aunque la ★ no cambie
  const [toast, setToast] = useState(null);  // { texto, deshacer?: { clave, principal } }
  const [ocupado, setOcupado] = useState(false);
  const reloj = useRef(null);

  const mostrar = (t, ms) => { clearTimeout(reloj.current); setToast(t); reloj.current = setTimeout(() => setToast(null), ms); };
  const avisar = (m) => mostrar({ texto: m }, 3500);
  const [fm, setFm] = useState(null);

  const cargar = useCallback(async () => {
    setResumen(await api("/api/resumen"));
    const l = await api(`/api/filas?estado=${pestana}&q=${encodeURIComponent(q)}&offset=${offset}&limite=${POR_PAGINA}`);
    setLista(l);
    return l;
  }, [q, offset, pestana]);

  // Después de normalizar se pasa a la fila siguiente de la lista (la que estaba debajo de la que
  // elegiste). Las otras variaciones del grupo aparecen cuando les toque su turno en la lista.
  // La burbuja trae Deshacer unos segundos.
  const fila = useRef(null);      // id de la fila de la lista en la que se hizo clic
  const listaRef = useRef(lista);
  listaRef.current = lista;
  const abrir = (f) => { fila.current = f ? f.id : null; if (f) { setClave(f.clave); setPrincipal(f.texto); } else setClave(null); setVersion((x) => x + 1); };

  const despuesDeNormalizar = async (texto, claveAntes, principalAntes, grupo, accion) => {
    mostrar({ texto, deshacer: { clave: claveAntes, principal: principalAntes, accion, fila: fila.current } }, 6000);
    const antes = listaRef.current.filas;
    const l = await cargar();
    const siguen = new Set(l.filas.map((f) => f.id));
    const i = antes.findIndex((f) => f.id === fila.current);
    abrir(antes.slice(i + 1).find((f) => siguen.has(f.id)) || l.filas[0]);
  };

  const deshacerDesdeBurbuja = async (info) => {
    setToast(null);
    try {
      const r = await api("/api/deshacer", { accion: info.accion });
      fila.current = info.fila; setClave(info.clave); setPrincipal(info.principal); setVersion((x) => x + 1);
      await cargar();
      avisar(r.mensaje);
    } catch (e) { avisar(e.message); }
  };

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
                  <td><button class="primario" onClick=${() => abrir(f)}>Verificar</button></td>
                </tr>`)}
            </tbody>
          </table>` : html`
          <table>
            <thead><tr><th></th><th>SKU</th><th>Impresora original</th><th>Normalizada como</th><th>Cómo</th><th>FileMaker</th></tr></thead>
            <tbody>
              ${lista.filas.map((f) => html`
                <tr key=${f.id}>
                  <td><button title="Esta impresora vuelve a Pendientes para corregirla"
                    onClick=${async () => {
                      try { const r = await api("/api/reabrir", { clave: f.clave, texto: f.texto }); avisar(r.mensaje); await cargar(); }
                      catch (e) { avisar(e.message); }
                    }}>Reabrir</button></td>
                  <td class="sku">${f.sku}</td>
                  <td>${f.texto}</td>
                  <td><b>${f.nombre}</b></td>
                  <td class="nota">${{ auto: "automático", manual: "manual", google: "Google" }[f.como] || f.como}</td>
                  <td class="nota">${envioFM(f)}</td>
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
          ? html`<${Grupo} clave=${clave} principal=${principal} version=${version} avisar=${avisar}
                   alNormalizar=${despuesDeNormalizar} />`
          : html`<div class="vacio">Toca <b>Verificar</b> en una impresora para ver sus coincidencias.</div>`}
      </section>
    </main>
    ${toast && html`<div class="toast">${toast.texto}
      ${toast.deshacer && html`<button class="deshacer" onClick=${() => deshacerDesdeBurbuja(toast.deshacer)}>Deshacer</button>`}
    </div>`}
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

function Grupo({ clave, principal, version, avisar, alNormalizar }) {
  const [g, setG] = useState(null);
  const [marcadas, setMarcadas] = useState({});
  const [nombre, setNombre] = useState("");
  const [consulta, setConsulta] = useState("");
  const [google, setGoogle] = useState(null);
  const [buscando, setBuscando] = useState(false);
  const [error, setError] = useState("");
  const [sel, setSel] = useState(0);          // variación seleccionada para el teclado (parte en la ★)
  const enviando = useRef(false);

  const cargarGrupo = useCallback(async () => {
    const d = await api(`/api/grupo?clave=${encodeURIComponent(clave)}`);
    // La principal (la que se tocó en la lista) va primera.
    d.variaciones.sort((a, b) => (b.llave === principal) - (a.llave === principal));
    setG(d);
    setMarcadas(Object.fromEntries(d.variaciones.map((v) => [v.llave, true])));
    return d;
  }, [clave, principal]);

  useEffect(() => {
    setNombre(""); setGoogle(null); setError(""); setG(null); setSel(0);
    cargarGrupo().then((d) => {
      setConsulta(`${d.marca} ${d.variaciones[0]?.texto || ""} impresora`.trim());
    }).catch((e) => setError(e.message));
  }, [clave, principal, version, cargarGrupo]);

  const llaves = g ? g.variaciones.filter((v) => marcadas[v.llave]).map((v) => v.llave) : [];
  const cuantos = g ? g.variaciones.filter((v) => marcadas[v.llave]).reduce((s, v) => s + v.cantidad, 0) : 0;

  // soloLlaves: para → (completa solo la seleccionada, tal cual)
  const normalizarComo = async (valor, como, soloLlaves) => {
    const usar = soloLlaves || llaves;
    if (!usar.length) return avisar("Marca al menos una variación.");
    if (enviando.current) return;
    enviando.current = true;
    try {
      const r = await api("/api/normalizar", { clave, llaves: usar, nombre: valor, como });
      const d = await api(`/api/grupo?clave=${encodeURIComponent(clave)}`);
      const texto = r.tal_cual
        ? `“${r.nombre}” completado tal cual (${r.registros} registros)`
        : `${r.textos.map((t) => `“${t}”`).join(", ")} → normalizado como “${r.nombre}” (${r.registros} registros)`;
      const extra = r.extra ? ` · “${r.extra_texto}” quedaba sola y se completó tal cual (${r.extra})` : "";
      await alNormalizar(texto + extra, clave, principal, d, r.accion);
    } catch (e) { avisar(e.message); }
    // pausa corta: una pulsación = una acción, aunque la tecla rebote o quede apretada
    setTimeout(() => { enviando.current = false; }, 600);
  };

  // Teclado: ↑ ↓ eligen la variación; → la completa tal cual y pasa a la siguiente.
  // No actúa mientras escribes en un campo de texto.
  useEffect(() => {
    const tecla = (e) => {
      const t = e.target;
      if (!g || !g.variaciones.length || (t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && t.type === "text")))) return;
      if (e.repeat) { e.preventDefault(); return; }  // tecla mantenida: no repetir acciones
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((i) => Math.min(i + 1, g.variaciones.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
      else if (e.key === "ArrowRight") {
        e.preventDefault();
        const v = g.variaciones[Math.min(sel, g.variaciones.length - 1)];
        normalizarComo(v.texto, "manual", [v.llave]);
      }
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  });

  if (!g) return html`<div class="vacio">${error || "Cargando…"}</div>`;

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
        <div class="nota" style=${{ marginTop: "8px" }}>Nombres ya usados en este grupo (toca uno para reutilizarlo):</div>
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
      ${g.variaciones.length > 0 && html`<div class="nota atajo">Teclado: ↑ ↓ eligen · → completa la elegida tal cual y pasa a la siguiente de la lista</div>`}
      ${g.variaciones.map((v, i) => html`
        <div class=${"var" + (i === sel ? " sel" : "")} key=${v.llave} onClick=${() => setSel(i)}>
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
