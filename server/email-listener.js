const { ImapFlow } = require('imapflow');

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
        const message = await client.fetchOne('*', { envelope: true }, { uid: false });
        if (!message) return;
        const remitente = message.envelope?.from?.[0]?.name || message.envelope?.from?.[0]?.address || 'Desconocido';
        const asunto = message.envelope?.subject || '(sin asunto)';
        const text = `📧 Correo nuevo de ${remitente} — ${asunto}`.slice(0, 300);

        const { error } = await supabase
          .from('notificaciones_sucursal')
          .insert({ sucursal_id: process.env.EMAIL_SUCURSAL || null, source: 'correo', text });
        if (error) console.error('Error guardando alerta de correo:', error);
      } catch (err) {
        console.error('Error procesando correo nuevo:', err.message);
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
