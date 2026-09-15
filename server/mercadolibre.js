// Integración Mercado Libre — ver investigacion-integraciones.md §1.1 para el
// diagrama completo. Resumen: hay un relay propio en Railway ("meli-proxy")
// que recibe el webhook REAL de ML y lo guarda en un buffer en memoria.
// GET /meli/webhook/events es NO destructivo (a diferencia de /consume, que
// usa FileMaker y vacía el buffer) — por eso lo usamos nosotros, sin pisarle
// nada a FileMaker.
//
// Los access tokens de las 3 cuentas activas NO viven en Supabase — viven en
// FileMaker (layout VARIABLESCONFIG), leídos vía su XML Web Publishing API.

const RELAY_EVENTS_URL = process.env.ML_RELAY_URL || 'https://mlwebhook-production.up.railway.app/meli/webhook/events';
const POLL_MS = Number(process.env.ML_POLL_MS || 60000);
const SUBSTATUS_FILTER = process.env.ML_SUBSTATUS_FILTER || 'ready_to_print';

// seller_id -> nombre de cuenta y campo Token en VARIABLESCONFIG.
const CUENTAS = {
  2914177676: { nombre: 'CUENTA4', tokenField: 'Token4' },
  1615390484: { nombre: 'CUENTA5', tokenField: 'Token5' },
  1613511081: { nombre: 'CUENTA6', tokenField: 'Token6' },
};

function extraerCampoXml(xml, nombreCampo) {
  const re = new RegExp(`<field name="${nombreCampo}"><data>([^<]*)</data></field>`);
  const m = xml.match(re);
  return m ? m[1] : '';
}

async function obtenerTokens() {
  const res = await fetch(process.env.FM_TOKENS_URL, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.FM_AUTH_USER}:${process.env.FM_AUTH_PASS}`).toString('base64') },
  });
  if (!res.ok) throw new Error(`FileMaker XML API respondió ${res.status}`);
  const xml = await res.text();
  const tokens = {};
  for (const [sellerId, cuenta] of Object.entries(CUENTAS)) {
    tokens[sellerId] = extraerCampoXml(xml, cuenta.tokenField);
  }
  return tokens;
}

async function obtenerEventosPendientes() {
  const res = await fetch(RELAY_EVENTS_URL);
  if (!res.ok) throw new Error(`Relay de ML respondió ${res.status}`);
  return res.json(); // [{ order_id, seller_id, ts }, ...]
}

async function enriquecerYGuardar(supabase, event, token, cuentaNombre) {
  const orderRes = await fetch(`https://api.mercadolibre.com/orders/${event.order_id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!orderRes.ok) throw new Error(`GET /orders/${event.order_id} -> ${orderRes.status}`);
  const order = await orderRes.json();

  const shippingId = order?.shipping?.id;
  if (!shippingId) return { guardado: false, motivo: 'sin shipping.id' };

  const shipRes = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!shipRes.ok) throw new Error(`GET /shipments/${shippingId} -> ${shipRes.status}`);
  const shipment = await shipRes.json();

  if (shipment.substatus !== SUBSTATUS_FILTER) {
    return { guardado: false, motivo: `substatus=${shipment.substatus}, esperando ${SUBSTATUS_FILTER}` };
  }

  const items = (order.order_items || []).map((oi) => ({
    titulo: oi.item?.title || '',
    cantidad: oi.quantity || 0,
    precio_unitario: oi.unit_price || 0,
  }));

  const { error } = await supabase.from('ventas_mercadolibre').upsert({
    order_id: String(order.id),
    cuenta_ml: cuentaNombre,
    cliente: order.buyer?.nickname || null,
    items,
    monto_total: order.total_amount || null,
    shipping_status: shipment.substatus,
  });
  if (error) throw error;

  return { guardado: true };
}

function startMercadoLibrePoller(supabase) {
  if (!process.env.FM_TOKENS_URL || !process.env.FM_AUTH_USER || !process.env.FM_AUTH_PASS) {
    console.log('FM_TOKENS_URL/FM_AUTH_USER/FM_AUTH_PASS no seteados — poller de Mercado Libre desactivado.');
    return;
  }

  // En memoria: evita reprocesar el mismo order_id en cada poll mientras siga
  // en el buffer del relay (que es no destructivo). Se resetea si el proceso
  // reinicia — inofensivo, el upsert de Supabase no duplica de todas formas.
  const procesados = new Set();

  async function ciclo() {
    try {
      const eventos = await obtenerEventosPendientes();
      const nuevos = eventos.filter((e) => e.order_id && !procesados.has(e.order_id));
      if (nuevos.length === 0) return;

      const tokens = await obtenerTokens();

      for (const event of nuevos) {
        procesados.add(event.order_id);
        const cuenta = CUENTAS[event.seller_id];
        if (!cuenta) {
          console.log(`ML: seller_id ${event.seller_id} no está en la lista de cuentas activas, se ignora.`);
          continue;
        }
        const token = tokens[event.seller_id];
        if (!token) {
          console.error(`ML: no hay token vigente para ${cuenta.nombre} — no se pudo procesar order_id ${event.order_id}`);
          continue;
        }
        try {
          const resultado = await enriquecerYGuardar(supabase, event, token, cuenta.nombre);
          console.log(`ML: order_id ${event.order_id} (${cuenta.nombre}) ->`, resultado);
        } catch (err) {
          console.error(`ML: error procesando order_id ${event.order_id}:`, err.message);
        }
      }

      // Buffer acotado — evita crecer sin límite en procesos de larga vida.
      if (procesados.size > 2000) {
        const restantes = [...procesados].slice(-1000);
        procesados.clear();
        restantes.forEach((id) => procesados.add(id));
      }
    } catch (err) {
      console.error('ML: error en el ciclo de polling:', err.message);
    }
  }

  ciclo();
  setInterval(ciclo, POLL_MS);
  console.log(`Poller de Mercado Libre activo (cada ${POLL_MS / 1000}s, filtrando substatus=${SUBSTATUS_FILTER})`);
}

module.exports = { startMercadoLibrePoller };
