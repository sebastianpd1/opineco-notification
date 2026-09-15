const webpush = require('web-push');

// Push web (PWA) — para empleados sin TV cerca. Se desactiva solo si no hay
// claves VAPID configuradas (generarlas una vez con `web-push generate-vapid-keys`
// y cargarlas en Railway; ver TODO.md).
function configurado() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

if (configurado()) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:sebastian@opineco.cl',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Manda el push a los dispositivos suscritos que correspondan a la sucursal
// (o a todos, si sucursal_id es null — mismo criterio que las alertas).
async function enviarPush(supabase, sucursal_id, { title, body, url }) {
  if (!configurado()) return;

  let query = supabase.from('push_subscriptions').select('*');
  query = sucursal_id ? query.or(`sucursal_id.eq.${sucursal_id},sucursal_id.is.null`) : query;
  const { data: subs, error } = await query;
  if (error) {
    console.error('Push: error leyendo suscripciones:', error);
    return;
  }

  const payload = JSON.stringify({ title, body, url });

  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
    } catch (err) {
      // 404/410 = la suscripción ya no existe del lado del navegador — se limpia.
      if (err.statusCode === 404 || err.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      } else {
        console.error('Push: error enviando a una suscripción:', err.message);
      }
    }
  }));
}

module.exports = { enviarPush, configurado };
