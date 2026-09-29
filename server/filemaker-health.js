// El servidor de FileMaker (FM_TOKENS_URL) a veces responde 200 con el
// cuerpo vacío — no tira error HTTP, simplemente no da datos. Esto revisa
// cada 10 min si de verdad está respondiendo (200 + contenido real), y
// guarda el último resultado en memoria para que el dashboard lo consulte.
const CHECK_MS = Number(process.env.FM_HEALTH_CHECK_MS || 10 * 60 * 1000);

let estado = {
  ok: null, // null = todavía no se chequeó ninguna vez
  ultimoCheck: null,
  detalle: null,
};

function obtenerEstadoFilemaker() {
  return estado;
}

async function chequearFilemaker() {
  if (!process.env.FM_TOKENS_URL || !process.env.FM_AUTH_USER || !process.env.FM_AUTH_PASS) {
    estado = { ok: null, ultimoCheck: new Date().toISOString(), detalle: 'FM_TOKENS_URL no configurado' };
    return;
  }
  const auth = Buffer.from(`${process.env.FM_AUTH_USER}:${process.env.FM_AUTH_PASS}`).toString('base64');
  try {
    const res = await fetch(process.env.FM_TOKENS_URL, { headers: { Authorization: `Basic ${auth}` } });
    const texto = await res.text();
    const ok = res.ok && texto.trim().length > 0;
    estado = {
      ok,
      ultimoCheck: new Date().toISOString(),
      detalle: ok ? null : `HTTP ${res.status}, cuerpo de ${texto.length} caracteres`,
    };
    if (!ok) console.error(`FileMaker health check: respuesta sin datos (HTTP ${res.status}, ${texto.length} chars)`);
  } catch (err) {
    estado = { ok: false, ultimoCheck: new Date().toISOString(), detalle: err.message };
    console.error('FileMaker health check: error de red:', err.message);
  }
}

function startFilemakerHealthCheck() {
  chequearFilemaker();
  setInterval(chequearFilemaker, CHECK_MS);
  console.log(`Chequeo de salud de FileMaker activo cada ${CHECK_MS / 1000}s`);
}

module.exports = { startFilemakerHealthCheck, obtenerEstadoFilemaker };
