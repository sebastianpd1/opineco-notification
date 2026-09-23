// Integración Mercado Libre — ver investigacion-integraciones.md §1.1 para el
// diagrama completo. Resumen: hay un relay propio en Railway ("meli-proxy")
// que recibe el webhook REAL de ML y lo guarda en un buffer en memoria.
// GET /meli/webhook/events es NO destructivo (a diferencia de /consume, que
// usa FileMaker y vacía el buffer) — por eso lo usamos nosotros, sin pisarle
// nada a FileMaker.
//
// Los access tokens de las 3 cuentas activas NO viven en Supabase — viven en
// FileMaker (layout VARIABLESCONFIG), leídos vía su XML Web Publishing API.

const { enviarPush } = require('./push');

const RELAY_EVENTS_URL = process.env.ML_RELAY_URL || 'https://mlwebhook-production.up.railway.app/meli/webhook/events';
const POLL_MS = Number(process.env.ML_POLL_MS || 60000);
const RECONCILE_MS = Number(process.env.ML_RECONCILE_MS || 5 * 60000);
const SUBSTATUS_FILTER = process.env.ML_SUBSTATUS_FILTER || 'ready_to_print';

// 3 baldes, igual que los despachos de courier (ver couriers.js):
// pendiente (nada de esto, es el default) -> enviada (ya salió, esperando
// que ML confirme entrega — antes se ocultaba acá directo, ahora pasa al
// widget "Enviados") -> final (se deja de trackear del todo).
const ESTADOS_ENVIADOS = ['shipped', 'not_delivered', 'stale_shipped'];
const ESTADOS_FINALES = ['delivered', 'cancelled', 'closed', 'error'];

// El `status` de nivel superior a veces tarda en pasar a "shipped" aunque el
// paquete YA salió físicamente de la sucursal — el `substatus` sí lo refleja
// al toque. Sin esto, pedidos que ya están en tránsito seguían apareciendo
// como pendientes en vez de en el widget "Enviados".
const SUBESTADOS_ENVIADOS = [
  'picked_up', 'dropped_off', 'in_transit',
  'on_route_to_pickup', 'picking_up', 'looking_for_driver',
  'in_hub',
];

function clasificarVenta(status, substatus) {
  if (ESTADOS_FINALES.includes(status)) return 'final';
  if (ESTADOS_ENVIADOS.includes(status) || SUBESTADOS_ENVIADOS.includes(substatus)) return 'en_transito';
  return 'pendiente';
}

// seller_id -> nombre de cuenta y campo Token en VARIABLESCONFIG.
const CUENTAS = {
  2914177676: { nombre: 'CUENTA4', tokenField: 'Token4' },
  1615390484: { nombre: 'CUENTA5', tokenField: 'Token5' },
  1613511081: { nombre: 'CUENTA6', tokenField: 'Token6' },
};
const CUENTA_POR_NOMBRE = Object.fromEntries(
  Object.entries(CUENTAS).map(([sellerId, c]) => [c.nombre, sellerId])
);

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

async function obtenerShipment(shippingId, token) {
  const res = await fetch(`https://api.mercadolibre.com/shipments/${shippingId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /shipments/${shippingId} -> ${res.status}`);
  return res.json();
}

// Mismo criterio que ya tenían programado en FileMaker (Case sobre
// logistic_type/tracking_method) — se replica acá tal cual para no
// duplicar lógica entre los dos sistemas más de lo necesario.
function medioEnvioMl(shipment) {
  const tipo = shipment.logistic_type;
  const metodo = shipment.tracking_method;
  if (tipo === 'self_service') return 'FLEX';
  if (tipo === 'xd_drop_off' && metodo === 'MEL Distribution') return 'MERCADO LIBRE';
  if (tipo === 'xd_drop_off' && metodo !== 'MEL Distribution') return 'BLUEXPRESS';
  return null;
}

async function enriquecerYGuardar(supabase, event, token, cuentaNombre) {
  const orderRes = await fetch(`https://api.mercadolibre.com/orders/${event.order_id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!orderRes.ok) throw new Error(`GET /orders/${event.order_id} -> ${orderRes.status}`);
  const order = await orderRes.json();

  const shippingId = order?.shipping?.id;
  if (!shippingId) return { guardado: false, motivo: 'sin shipping.id' };

  const shipment = await obtenerShipment(shippingId, token);

  if (shipment.substatus !== SUBSTATUS_FILTER) {
    return { guardado: false, motivo: `substatus=${shipment.substatus}, esperando ${SUBSTATUS_FILTER}` };
  }

  const items = (order.order_items || []).map((oi) => ({
    titulo: oi.item?.title || '',
    cantidad: oi.quantity || 0,
    precio_unitario: oi.unit_price || 0,
  }));

  // "Fecha estimada de envío": Mercado Libre no siempre la rellena — cuando
  // no hay dato real, esto queda null (no hay campo confiable alternativo).
  const fechaEnvioEstimada = shipment.shipping_option?.estimated_delivery_time?.date || null;

  const { error } = await supabase.from('ventas_mercadolibre').upsert({
    order_id: String(order.id),
    cuenta_ml: cuentaNombre,
    cliente: order.buyer?.nickname || null,
    items,
    monto_total: order.total_amount || null,
    shipping_id: String(shippingId),
    shipping_status: shipment.status,
    shipping_substatus: shipment.substatus,
    tracking_number: shipment.tracking_number || null,
    medio_envio: medioEnvioMl(shipment),
    fecha_compra: order.date_created || null,
    fecha_envio_estimada: fechaEnvioEstimada,
  });
  if (error) throw error;

  const item = items[0]?.titulo || 'producto';
  enviarPush(supabase, null, { title: 'Mercado Libre', body: `Venta nueva (${cuentaNombre}) — ${item}`, url: '/' }).catch(() => {});

  return { guardado: true };
}

// Revisa las ventas que todavía no llegaron a un estado final y actualiza su
// estado real — sigue trackeando incluso después de "shipped" (a diferencia
// de antes) para poder detectar cuando un courier nunca llega a confirmar
// la entrega.
async function reconciliar(supabase) {
  const { data: pendientes, error: selectError } = await supabase
    .from('ventas_mercadolibre')
    .select('order_id, cuenta_ml, shipping_id, shipped_at')
    .not('shipping_status', 'in', `(${ESTADOS_FINALES.join(',')})`)
    .not('shipping_id', 'is', null);
  if (selectError) {
    console.error('ML reconciliación: error leyendo pendientes:', selectError);
    return;
  }
  if (pendientes.length === 0) return;

  const tokens = await obtenerTokens();

  for (const venta of pendientes) {
    const sellerId = CUENTA_POR_NOMBRE[venta.cuenta_ml];
    const token = sellerId && tokens[sellerId];
    if (!token) {
      console.error(`ML reconciliación: sin token para ${venta.cuenta_ml}, se salta ${venta.order_id}`);
      continue;
    }
    try {
      const shipment = await obtenerShipment(venta.shipping_id, token);
      const update = {
        shipping_status: shipment.status,
        shipping_substatus: shipment.substatus,
        tracking_number: shipment.tracking_number || null,
        medio_envio: medioEnvioMl(shipment),
      };
      // shipped_at marca cuándo entró al balde "enviada" — se setea una sola
      // vez, la primera vez que se detecta (no en cada reconciliación).
      if (!venta.shipped_at && clasificarVenta(shipment.status, shipment.substatus) === 'en_transito') {
        update.shipped_at = new Date().toISOString();
      }
      const { error } = await supabase.from('ventas_mercadolibre').update(update).eq('order_id', venta.order_id);
      if (error) throw error;
      console.log(`ML reconciliación: order_id ${venta.order_id} -> status=${shipment.status}`);
    } catch (err) {
      console.error(`ML reconciliación: error con order_id ${venta.order_id}:`, err.message);
    }
  }
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
  setInterval(() => reconciliar(supabase).catch((err) => console.error('ML reconciliación falló:', err.message)), RECONCILE_MS);
  console.log(`Poller de Mercado Libre activo (cada ${POLL_MS / 1000}s, reconciliación cada ${RECONCILE_MS / 1000}s, filtrando substatus=${SUBSTATUS_FILTER})`);
}

module.exports = { startMercadoLibrePoller, clasificarVenta };
