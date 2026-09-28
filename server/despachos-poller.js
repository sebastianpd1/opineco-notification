// Poller de estado de despachos (Starken / Rappi / Blue Express) — mismo
// criterio que server/mercadolibre.js para ML: acá SÍ le pegamos nosotros
// directo a la API de cada courier (no FileMaker). FileMaker solo nos tiene
// que mandar `transportista` + `tracking_number` al emitir la etiqueta (ver
// filemaker-scripts.md §2) — el resto lo hacemos solos.
const https = require('https');
const { clasificarEnvio } = require('./couriers');

const STARKEN_TOKEN = process.env.STARKEN_API_TOKEN;
const RAPPI_TOKEN = process.env.RAPPI_API_TOKEN;
const POLL_MS = Number(process.env.DESPACHOS_POLL_MS || 10 * 60 * 1000);

async function consultarStarken(ordenFlete) {
  const res = await fetch(`https://apiprod.starkenpro.cl/integration/integracion/tracking/orden-flete/of/${ordenFlete}`, {
    headers: { Authorization: `Bearer ${STARKEN_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Starken respondió ${res.status}`);
  const data = await res.json();
  return data.status || null; // "EN ORIGEN" | "EN CD" | "EN TRANSITO" | "EN DESTINO" | "ENTREGADO"
}

// La propia doc de Rappi manda esto como GET con body (`curl -X GET ... -d`)
// — no es un método estándar, y el fetch de Node lo rechaza directo
// ("Request with GET/HEAD method cannot have body"). Por eso va con el
// módulo https de más bajo nivel, que si lo permite, igual que curl.
function consultarRappi(idPedido) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ IdPedido: Number(idPedido) });
    const req = https.request('https://rapiboy.com/v1/NextDaySmart/Get', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Token: RAPPI_TOKEN,
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Rappi respondió ${res.statusCode}`));
        }
        try {
          const data = JSON.parse(body);
          resolve(data?.Unico?.EstadoNombre || null);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function consultarBlue(os) {
  const res = await fetch('https://www.blue.cl/api/tracking/microestado', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' },
    body: JSON.stringify({ os }),
  });
  if (!res.ok) throw new Error(`Blue Express respondió ${res.status}`);
  const data = await res.json();
  const evento = data?.data?.traceMicrostates?.microstates?.[0]?.events?.[0];
  return evento?.eventCode || null;
}

// tracking_number guarda cosas distintas según el courier — cada uno pide
// un identificador distinto en su API:
//   STARKEN -> orden_flete (el "of" de la URL)
//   RAPPI   -> IdPedido (el número del pedido, NO el TrackingEncriptado)
//   BLUE    -> os (código de bulto de la etiqueta, no el transactionId)
const CONSULTORES = { STARKEN: consultarStarken, RAPPI: consultarRappi, BLUE: consultarBlue };

async function poll(supabase) {
  const { data: pendientes, error } = await supabase
    .from('pedidos_despachar')
    .select('id, transportista, estado_envio, tracking_number')
    .not('transportista', 'is', null)
    .not('tracking_number', 'is', null);
  if (error) return console.error('Despachos: error leyendo pendientes:', error);

  for (const p of pendientes) {
    // Ya entregado no hace falta seguir consultando — el job de limpieza
    // del hub (server.js) se encarga de borrarlo poco después.
    if (clasificarEnvio(p.transportista, p.estado_envio) === 'entregado') continue;

    const consultar = CONSULTORES[p.transportista];
    if (!consultar) continue;

    try {
      const estado = await consultar(p.tracking_number);
      if (!estado || estado === p.estado_envio) continue; // sin dato o sin cambios

      const { error: updateError } = await supabase
        .from('pedidos_despachar')
        .update({ estado_envio: estado })
        .eq('id', p.id);
      if (updateError) console.error(`Despachos: error actualizando ${p.id}:`, updateError);
      else console.log(`Despachos: ${p.transportista} ${p.id} -> ${estado}`);
    } catch (err) {
      console.error(`Despachos: error consultando ${p.transportista} para ${p.id} (tracking ${p.tracking_number}):`, err.message);
    }
  }
}

function startDespachosPoller(supabase) {
  if (!STARKEN_TOKEN) console.log('STARKEN_API_TOKEN no seteado — despachos de Starken no se van a actualizar solos.');
  if (!RAPPI_TOKEN) console.log('RAPPI_API_TOKEN no seteado — despachos de Rappi no se van a actualizar solos.');
  // Blue Express no necesita token, así que siempre queda activo.

  poll(supabase);
  setInterval(() => poll(supabase), POLL_MS);
  console.log(`Poller de despachos (Starken/Rappi/Blue) activo cada ${POLL_MS / 1000}s`);
}

module.exports = { startDespachosPoller };
