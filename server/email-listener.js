const { ImapFlow } = require('imapflow');
const { enviarPush } = require('./push');

// Correo de GoDaddy (webmail legacy, sin webhook nativo) — la única opción es
// mantener una conexión IMAP persistente en modo IDLE y reconectar sola si se
// cae. Ver investigacion-integraciones.md sección 3 para el porqué.
//
// EMAIL_SUCURSAL: si el buzón es de una sucursal puntual, poné su id acá.
// Si es el correo general de la empresa, dejalo sin setear (queda broadcast).

// Dedupe por las dudas: si alguna vez queda más de una conexión viva a la
// vez (ej. durante una reconexión que no cerró bien la anterior), esto evita
// que el mismo correo dispare varias notificaciones. Guarda solo los últimos
// UID, no crece sin límite.
const uidsNotificados = new Set();
function yaNotificado(uid) {
  if (uidsNotificados.has(uid)) return true;
  uidsNotificados.add(uid);
  if (uidsNotificados.size > 200) {
    const [primero] = uidsNotificados;
    uidsNotificados.delete(primero);
  }
  return false;
}

// El evento 'flags' de abajo solo avisa de cambios que pasan MIENTRAS la
// conexión IDLE está viva — si se cae y reconecta (pasa cada tanto), un
// correo marcado \Seen durante esa ventana muerta queda sin cerrar para
// siempre, y la burbujita de correo queda contando cosas que ya se leyeron.
// Por eso, cada vez que se (re)conecta, se revisa el estado real de todos
// los pendientes antes de volver a escuchar en vivo.
async function reconciliarLeidos(supabase, client) {
  const { data: pendientes, error } = await supabase
    .from('notificaciones_sucursal')
    .select('id, external_ref')
    .eq('source', 'correo')
    .is('acknowledged_at', null)
    .not('external_ref', 'is', null);
  if (error) return console.error('Error leyendo correos pendientes para reconciliar:', error);

  for (const notif of pendientes) {
    try {
      const mensaje = await client.fetchOne(notif.external_ref, { flags: true }, { uid: true });
      if (mensaje && mensaje.flags && mensaje.flags.has('\\Seen')) {
        const { error: updateError } = await supabase
          .from('notificaciones_sucursal')
          .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: 'auto:correo_leido_reconciliado' })
          .eq('id', notif.id);
        if (updateError) console.error('Error reconciliando correo leído:', updateError);
      }
    } catch (err) {
      // Uid ya no existe en el buzón (borrado/movido) — no es un error real.
    }
  }
}

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

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      await reconciliarLeidos(supabase, client);

      client.on('exists', async () => {
        // Llegó correo nuevo — traer el más reciente sin marcarlo como leído.
        try {
          const message = await client.fetchOne('*', { envelope: true, uid: true }, { uid: false });
          if (!message) return;
          if (yaNotificado(String(message.uid))) return;

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
  } finally {
    // Crítico: si esto no se llama, la conexión puede quedar viva del lado
    // del servidor IMAP mientras el próximo ciclo del loop abre una nueva —
    // dos conexiones escuchando el mismo buzón = notificaciones duplicadas.
    try { await client.logout(); } catch { client.close(); }
  }
}

function startEmailListener(supabase) {
  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('EMAIL_HOST/EMAIL_USER/EMAIL_PASS no seteados — listener de correo desactivado.');
    return;
  }

  const RETRY_MS = 30000;
  let corriendo = false;
  async function loop() {
    // Nunca dos ciclos en simultáneo — si por lo que sea el anterior sigue
    // vivo cuando el timer dispara de nuevo, no arrancamos uno encima.
    if (corriendo) return;
    corriendo = true;
    try {
      await connectAndWatch(supabase);
    } catch (err) {
      console.error('Listener de correo cortado, reintentando en 30s:', err.message);
    } finally {
      corriendo = false;
    }
    setTimeout(loop, RETRY_MS);
  }
  loop();
}

module.exports = { startEmailListener };
