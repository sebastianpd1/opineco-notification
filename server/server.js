require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { startDiscordBot } = require('./discord-bot');
const { startEmailListener } = require('./email-listener');
const { startMercadoLibrePoller, ESTADOS_ENVIADOS: ML_ESTADOS_ENVIADOS, ESTADOS_FINALES: ML_ESTADOS_FINALES } = require('./mercadolibre');
const { enviarPush } = require('./push');
const { clasificarEnvio } = require('./couriers');

// Red de seguridad: un bug en cualquier integración (Discord, correo, etc.)
// no debe tumbar el hub entero — acá también vive el dashboard y la API.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (el hub sigue corriendo):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection (el hub sigue corriendo):', err);
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
startDiscordBot(supabase);
startEmailListener(supabase);
startMercadoLibrePoller(supabase);

// Red de seguridad universal: cualquier alerta sin acuse de recibo que ya
// tenga más de 24hs se cierra sola — no importa la fuente ni si la señal
// específica de esa integración (reply, chat:end, \Seen) falló o no existe.
const VEINTICUATRO_HS_MS = 24 * 60 * 60 * 1000;
async function limpiarAlertasVencidas() {
  const limite = new Date(Date.now() - VEINTICUATRO_HS_MS).toISOString();
  const { error } = await supabase
    .from('notificaciones_sucursal')
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: 'auto:expirado_24h' })
    .is('acknowledged_at', null)
    .lt('created_at', limite);
  if (error) console.error('Error limpiando alertas vencidas:', error);
}
limpiarAlertasVencidas();
setInterval(limpiarAlertasVencidas, 30 * 60 * 1000);

// Borra los despachos de courier que ya llegaron a "entregado" — FileMaker
// solo tiene que mandar el PATCH con el estado crudo (ver couriers.js),
// el hub decide solo cuándo ya está resuelto y limpia la fila (mismo
// criterio "sin historial" que ya tenía esta tabla).
async function limpiarDespachosEntregados() {
  const { data, error } = await supabase.from('pedidos_despachar').select('id, transportista, estado_envio');
  if (error) return console.error('Error leyendo pedidos_despachar para limpieza:', error);

  const idsEntregados = data
    .filter((p) => clasificarEnvio(p.transportista, p.estado_envio) === 'entregado')
    .map((p) => p.id);
  if (idsEntregados.length === 0) return;

  const { error: deleteError } = await supabase.from('pedidos_despachar').delete().in('id', idsEntregados);
  if (deleteError) console.error('Error limpiando despachos entregados:', deleteError);
}
limpiarDespachosEntregados();
setInterval(limpiarDespachosEntregados, 10 * 60 * 1000);

const app = express();

// Webhook de Tawk.to: va ANTES de express.json() porque necesitamos el body
// crudo (Buffer) para verificar la firma HMAC-SHA1 antes de parsearlo.
// TAWK_PROPERTIES: JSON opcional {"propertyId": "sucursal_id o null"} para
// mapear de qué property vino el chat — sin esto, todo es broadcast.
app.post('/api/webhooks/tawk', express.raw({ type: '*/*' }), async (req, res) => {
  const secret = process.env.TAWK_WEBHOOK_SECRET;
  if (secret) {
    const signature = req.get('X-Tawk-Signature') || '';
    const expected = crypto.createHmac('sha1', secret).update(req.body).digest('hex');
    if (signature !== expected) return res.status(401).json({ error: 'firma inválida' });
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'json inválido' });
  }

  res.status(200).end(); // responder rápido, Tawk reintenta si no hay 2xx pronto

  if (payload.event === 'chat:end') {
    // El chat terminó — lo tomamos como señal de "ya se atendió" y cerramos
    // sola la alerta que abrió el chat:start correspondiente, sin esperar
    // que alguien la toque a mano en la pantalla.
    const { error } = await supabase
      .from('notificaciones_sucursal')
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: 'auto:chat_end' })
      .eq('source', 'tawk')
      .eq('external_ref', payload.chatId)
      .is('acknowledged_at', null);
    if (error) console.error('Error auto-cerrando chat de Tawk:', error);
    return;
  }

  if (payload.event !== 'chat:start') return; // los demás eventos no nos interesan

  let propertyMap = {};
  try { propertyMap = JSON.parse(process.env.TAWK_PROPERTIES || '{}'); } catch { /* queda vacío */ }
  const sucursal_id = propertyMap[payload.property?.id] || null;

  const visitante = payload.visitor?.name || 'Visitante';
  const text = `💬 Chat nuevo en Tawk.to — ${visitante}`;

  const { error } = await supabase
    .from('notificaciones_sucursal')
    .insert({ sucursal_id, source: 'tawk', text, external_ref: payload.chatId });
  if (error) console.error('Error guardando chat de Tawk:', error);
  else enviarPush(supabase, sucursal_id, { title: 'Tawk.to', body: text, url: '/' }).catch(() => {});
});

app.use(express.json());

// El HTML y el service worker nunca se cachean — un sw.js viejo se puede
// quedar pegado indefinidamente en el navegador/PWA y nunca actualizarse
// solo (problema clásico de PWAs). Se sirven directo acá, antes de
// express.static, para que ningún Cache-Control por default los pise.
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'pantalla-sucursal.html'));
});
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});
app.get('/manifest.json', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.use(express.static(path.join(__dirname, 'public')));

// Si se define HUB_API_KEY, las escrituras (POST/PATCH) requieren el
// header X-Hub-Key. En local, sin la variable seteada, no se exige.
function requireApiKey(req, res, next) {
  const expected = process.env.HUB_API_KEY;
  if (!expected) return next();
  if (req.get('X-Hub-Key') !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function handleSupabaseError(res, error) {
  console.error(error);
  res.status(500).json({ error: error.message || 'error de base de datos' });
}

// ---------- Sucursales ----------
app.get('/api/sucursales/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('sucursales')
    .select('id, nombre')
    .eq('id', req.params.id)
    .maybeSingle();
  if (error) return handleSupabaseError(res, error);
  if (!data) return res.status(404).json({ error: 'sucursal no encontrada' });
  res.json(data);
});

// ---------- Alertas (tabla notificaciones_sucursal) ----------
// sucursal_id null = broadcast a todas las pantallas.
app.get('/api/alerts', async (req, res) => {
  const { sucursal } = req.query;
  let query = supabase
    .from('notificaciones_sucursal')
    .select('*')
    .is('acknowledged_at', null)
    .order('created_at', { ascending: true });
  if (sucursal) query = query.or(`sucursal_id.eq.${sucursal},sucursal_id.is.null`);

  const { data, error } = await query;
  if (error) return handleSupabaseError(res, error);
  res.json(data);
});

app.post('/api/alerts', requireApiKey, async (req, res) => {
  const { sucursal_id, source, title, text, priority } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text requerido' });

  const { data, error } = await supabase
    .from('notificaciones_sucursal')
    .insert({ sucursal_id: sucursal_id || null, source: source || 'manual', title, text, priority: priority || 'normal' })
    .select()
    .single();
  if (error) return handleSupabaseError(res, error);
  enviarPush(supabase, sucursal_id || null, { title: title || 'Centro de Alertas', body: text, url: '/' }).catch(() => {});
  res.status(201).json(data);
});

// Acuse de recibo: no se borra, se marca como vista + quién la vio.
app.patch('/api/alerts/:id', requireApiKey, async (req, res) => {
  const { acknowledged_by } = req.body || {};
  const { data, error } = await supabase
    .from('notificaciones_sucursal')
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: acknowledged_by || null })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return handleSupabaseError(res, error);
  if (!data) return res.status(404).json({ error: 'no encontrada' });
  res.json(data);
});

// Badge-count por fuente (Discord/Tawk/Correo) para los íconos del header —
// cuenta alertas sin acuse de recibo, dirigidas a la sucursal o broadcast.
app.get('/api/alerts/counts', async (req, res) => {
  const { sucursal } = req.query;
  const sources = ['discord', 'tawk', 'correo'];
  try {
    const results = await Promise.all(sources.map((source) => {
      let query = supabase
        .from('notificaciones_sucursal')
        .select('*', { count: 'exact', head: true })
        .eq('source', source)
        .is('acknowledged_at', null);
      if (sucursal) query = query.or(`sucursal_id.eq.${sucursal},sucursal_id.is.null`);
      return query;
    }));
    const counts = {};
    sources.forEach((source, i) => {
      if (results[i].error) throw results[i].error;
      counts[source] = results[i].count || 0;
    });
    res.json(counts);
  } catch (error) {
    handleSupabaseError(res, error);
  }
});

// Acuses de recibo de esta sucursal en las últimas 12 horas (para el
// carrusel de "mensaje leído" en la pantalla).
app.get('/api/alerts/leidas', async (req, res) => {
  const { sucursal } = req.query;
  if (!sucursal) return res.json([]);
  const desde = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('notificaciones_sucursal')
    .select('id, acknowledged_at')
    .eq('acknowledged_by', sucursal)
    .gte('acknowledged_at', desde)
    .order('acknowledged_at', { ascending: false });
  if (error) return handleSupabaseError(res, error);
  res.json(data);
});

// ---------- Pedidos a retirar ----------
// Cola en vivo, sin historial: se inserta al crear el pedido y se borra
// cuando el cliente lo retira. FileMaker puede escribir/borrar acá directo
// contra Supabase (mismo patrón que ya usan para otras tablas) o vía el hub.
app.get('/api/pedidos/retirar', async (req, res) => {
  const { sucursal } = req.query;
  let query = supabase.from('pedidos_retirar').select('*').order('created_at', { ascending: true });
  if (sucursal) query = query.eq('sucursal_id', sucursal);

  const { data, error } = await query;
  if (error) return handleSupabaseError(res, error);
  res.json(data);
});

app.post('/api/pedidos/retirar', requireApiKey, async (req, res) => {
  const { id, sucursal_id, cliente, detalle } = req.body || {};
  if (!id || !sucursal_id || !cliente) {
    return res.status(400).json({ error: 'id, sucursal_id y cliente requeridos' });
  }
  const { data, error } = await supabase
    .from('pedidos_retirar')
    .insert({ id, sucursal_id, cliente, detalle: detalle || null })
    .select()
    .single();
  if (error) return handleSupabaseError(res, error);
  res.status(201).json(data);
});

app.delete('/api/pedidos/retirar/:id', requireApiKey, async (req, res) => {
  const { error } = await supabase.from('pedidos_retirar').delete().eq('id', req.params.id);
  if (error) return handleSupabaseError(res, error);
  res.status(204).end();
});

// ---------- Pedidos a despachar ----------
// Una vez que el courier (Starken/Rappi/Blue Express) marca el envío como
// "en tránsito", el pedido se muda al widget de Enviados (GET
// /api/envios-en-transito) — acá solo quedan los que todavía no salieron.
app.get('/api/pedidos/despachar', async (req, res) => {
  const { sucursal } = req.query;
  let query = supabase.from('pedidos_despachar').select('*').order('created_at', { ascending: true });
  if (sucursal) query = query.eq('sucursal_id', sucursal);

  const { data, error } = await query;
  if (error) return handleSupabaseError(res, error);
  const pendientes = data.filter((p) => clasificarEnvio(p.transportista, p.estado_envio) === 'pendiente');
  res.json(pendientes);
});

app.post('/api/pedidos/despachar', requireApiKey, async (req, res) => {
  const { id, sucursal_id, cliente, destino, detalle, transportista } = req.body || {};
  if (!id || !sucursal_id || !cliente) {
    return res.status(400).json({ error: 'id, sucursal_id y cliente requeridos' });
  }
  const { data, error } = await supabase
    .from('pedidos_despachar')
    .insert({ id, sucursal_id, cliente, destino: destino || null, detalle: detalle || null, transportista: transportista || null })
    .select()
    .single();
  if (error) return handleSupabaseError(res, error);
  res.status(201).json(data);
});

app.delete('/api/pedidos/despachar/:id', requireApiKey, async (req, res) => {
  const { error } = await supabase.from('pedidos_despachar').delete().eq('id', req.params.id);
  if (error) return handleSupabaseError(res, error);
  res.status(204).end();
});

// ---------- Ventas Mercado Libre ----------
// Solo las pendientes (ver investigacion-integraciones.md §1.1) — las
// "enviadas" viven en GET /api/envios-en-transito, las finales no se
// muestran en ningún lado.
const ML_NO_PENDIENTE = [...ML_ESTADOS_ENVIADOS, ...ML_ESTADOS_FINALES];

app.get('/api/ventas-ml', async (req, res) => {
  const { data, error } = await supabase
    .from('ventas_mercadolibre')
    .select('*')
    .not('shipping_status', 'in', `(${ML_NO_PENDIENTE.join(',')})`)
    .order('created_at', { ascending: false });
  if (error) return handleSupabaseError(res, error);
  res.json(data);
});

// ---------- Envíos en tránsito (widget 3: ML + despachos de courier) ----------
// Todo lo que ya salió de la sucursal pero todavía no tiene confirmación de
// entrega — para pillar a tiempo los casos donde el courier nunca la
// confirma, en vez de que la venta/pedido desaparezca sin más.
app.get('/api/envios-en-transito', async (req, res) => {
  const { sucursal } = req.query;
  let despachoQuery = supabase.from('pedidos_despachar').select('*');
  if (sucursal) despachoQuery = despachoQuery.eq('sucursal_id', sucursal);

  const [despachoRes, ventasRes] = await Promise.all([
    despachoQuery,
    supabase.from('ventas_mercadolibre').select('*').in('shipping_status', ML_ESTADOS_ENVIADOS),
  ]);
  if (despachoRes.error) return handleSupabaseError(res, despachoRes.error);
  if (ventasRes.error) return handleSupabaseError(res, ventasRes.error);

  const despachosEnTransito = despachoRes.data
    .filter((p) => clasificarEnvio(p.transportista, p.estado_envio) === 'en_transito')
    .map((p) => ({
      source: p.transportista || 'despacho',
      id: p.id,
      cliente: p.cliente,
      detalle: p.destino || p.detalle || '',
      estado_texto: p.estado_envio,
    }));

  const ventasEnTransito = ventasRes.data.map((v) => ({
    source: 'ML',
    id: v.order_id,
    cliente: v.cliente,
    detalle: (v.items && v.items[0]?.titulo) || v.cuenta_ml,
    cuenta_ml: v.cuenta_ml,
    estado_status: v.shipping_status,
    estado_substatus: v.shipping_substatus,
  }));

  res.json([...despachosEnTransito, ...ventasEnTransito]);
});

// ---------- Push web (PWA) ----------
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(404).json({ error: 'push no configurado' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', async (req, res) => {
  const { subscription, sucursal_id } = req.body || {};
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'subscription inválida' });
  }
  const { error } = await supabase.from('push_subscriptions').upsert({
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    sucursal_id: sucursal_id || null,
  });
  if (error) return handleSupabaseError(res, error);
  res.status(201).json({ ok: true });
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) return handleSupabaseError(res, error);
  res.status(204).end();
});

// Conveniencia: si alguien configura el kiosko con /<sucursal> en vez de
// /?sucursal=<sucursal> (pasó con Lampa), redirige en vez de dar 404. Va al
// final, después de todas las rutas reales y de los estáticos, para no
// pisar nada.
app.get('/:posibleSucursal', (req, res, next) => {
  if (req.params.posibleSucursal.includes('.')) return next(); // ej. favicon.ico
  res.redirect(302, `/?sucursal=${encodeURIComponent(req.params.posibleSucursal)}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hub escuchando en http://localhost:${PORT}`);
});
