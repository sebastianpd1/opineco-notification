const { ImapFlow } = require('imapflow');
const { enviarPush } = require('./push');

// Correo de GoDaddy (webmail legacy, sin webhook nativo) — la única opción es
// mantener una conexión IMAP persistente en modo IDLE y reconectar sola si se
// cae. Ver investigacion-integraciones.md sección 3 para el porqué.
//
// EMAIL_SUCURSAL: si el buzón es de una sucursal puntual, poné su id acá.
// Si es el correo general de la empresa, dejalo sin setear (queda broadcast).
async function connectAndWatch(supabase) {
  const client = new ImapFlow({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT || 993),
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    logger: false,
  });

  client.on('error', (err) => {
    console.error('Error de conexión IMAP:', err.message);
  });

  await client.connect();
  console.log(`Listener de correo conectado (${process.env.EMAIL_USER})`);

  const lock = await client.getMailboxLock('INBOX');
  try {
    client.on('exists', async () => {
      // Llegó correo nuevo — traer el más reciente sin marcarlo como leído.
      try {
        const message = await client.fetchOne('*', { envelope: true, uid: true }, { uid: false });
        if (!message) return;
        const remitente = message.envelope?.from?.[0]?.name || message.envelope?.from?.[0]?.address || 'Desconocido';
        const asunto = message.envelope?.subject || '(sin asunto)';
        const text = `📧 Correo nuevo de ${remitente} — ${asunto}`.slice(0, 300);

        const sucursal_id = process.env.EMAIL_SUCURSAL || null;
        const { error } = await supabase
          .from('notificaciones_sucursal')
          .insert({ sucursal_id, source: 'correo', text, external_ref: String(message.uid) });
        if (error) console.error('Error guardando alerta de correo:', error);
        else enviarPush(supabase, sucursal_id, { title: 'Correo', body: text, url: '/' }).catch(() => {});
      } catch (err) {
        console.error('Error procesando correo nuevo:', err.message);
      }
    });

    // Si el correo se marca leído (\Seen) desde cualquier cliente de mail,
    // cerramos sola la alerta correspondiente — así no queda pisando la TV
    // algo que la persona ya vio en su bandeja.
    // Ojo: el evento trae `seq` (número de secuencia), no `uid` directo, y
    // `flags` es un array plano — hay que resolver el UID real con un fetch.
    client.on('flags', async (update) => {
      try {
        const flags = Array.isArray(update.flags) ? update.flags : [...(update.flags || [])];
        if (!flags.includes('\\Seen')) return;
        if (!update.seq) return;

        const message = await client.fetchOne(String(update.seq), { uid: true });
        if (!message) return;

        const { error } = await supabase
          .from('notificaciones_sucursal')
          .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: 'auto:correo_leido' })
          .eq('source', 'correo')
          .eq('external_ref', String(message.uid))
          .is('acknowledged_at', null);
        if (error) console.error('Error auto-cerrando alerta de correo:', error);
      } catch (err) {
        console.error('Error procesando cambio de flags de correo:', err.message);
      }
    });

    await client.idle();
  } finally {
    lock.release();
  }
}

function startEmailListener(supabase) {
  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('EMAIL_HOST/EMAIL_USER/EMAIL_PASS no seteados — listener de correo desactivado.');
    return;
  }

  const RETRY_MS = 30000;
  async function loop() {
    try {
      await connectAndWatch(supabase);
    } catch (err) {
      console.error('Listener de correo cortado, reintentando en 30s:', err.message);
    }
    setTimeout(loop, RETRY_MS);
  }
  loop();
}

module.exports = { startEmailListener };
