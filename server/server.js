require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { startDiscordBot } = require('./discord-bot');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
startDiscordBot(supabase);

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

  if (payload.event !== 'chat:start') return; // único evento que usamos, ver investigacion-integraciones.md

  let propertyMap = {};
  try { propertyMap = JSON.parse(process.env.TAWK_PROPERTIES || '{}'); } catch { /* queda vacío */ }
  const sucursal_id = propertyMap[payload.property?.id] || null;

  const visitante = payload.visitor?.name || 'Visitante';
  const text = `💬 Chat nuevo en Tawk.to — ${visitante}`;

  const { error } = await supabase.from('notificaciones_sucursal').insert({ sucursal_id, source: 'tawk', text });
  if (error) console.error('Error guardando chat de Tawk:', error);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pantalla-sucursal.html'));
});

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
    const counts = {};
    for (const source of sources) {
      let query = supabase
        .from('notificaciones_sucursal')
        .select('*', { count: 'exact', head: true })
        .eq('source', source)
        .is('acknowledged_at', null);
      if (sucursal) query = query.or(`sucursal_id.eq.${sucursal},sucursal_id.is.null`);
      const { count, error } = await query;
      if (error) throw error;
      counts[source] = count || 0;
    }
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
app.get('/api/pedidos/despachar', async (req, res) => {
  const { sucursal } = req.query;
  let query = supabase.from('pedidos_despachar').select('*').order('created_at', { ascending: true });
  if (sucursal) query = query.eq('sucursal_id', sucursal);

  const { data, error } = await query;
  if (error) return handleSupabaseError(res, error);
  res.json(data);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hub escuchando en http://localhost:${PORT}`);
});
