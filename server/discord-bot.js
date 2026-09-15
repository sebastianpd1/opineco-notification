const { Client, GatewayIntentBits } = require('discord.js');
const { enviarPush } = require('./push');

// DISCORD_CHANNELS: JSON con mapeo canal -> sucursal, ej.
//   {"123456789012345678": "providencia", "234567890123456789": null}
// null (o el canal ausente del mapa) = no se escucha ese canal.
// Si querés que un canal avise a TODAS las sucursales, usá null como valor.
function parseChannelMap() {
  try {
    const parsed = JSON.parse(process.env.DISCORD_CHANNELS || '{}');
    const esObjetoPlano = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
    if (!esObjetoPlano) {
      console.error(`DISCORD_CHANNELS debe ser un objeto JSON como {"canalId": "sucursal"} — vino: ${process.env.DISCORD_CHANNELS}`);
      return {};
    }
    return parsed;
  } catch {
    console.error('DISCORD_CHANNELS no es JSON válido — el bot no va a reenviar nada.');
    return {};
  }
}

function startDiscordBot(supabase) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log('DISCORD_BOT_TOKEN no seteado — bot de Discord desactivado.');
    return;
  }

  const channelMap = parseChannelMap();
  if (Object.keys(channelMap).length === 0) {
    console.log('DISCORD_CHANNELS vacío — bot de Discord conectado pero sin canales configurados.');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
  });

  // Cierra sola la alerta de un mensaje de Discord — se usa tanto para
  // reacciones como para replies, las dos señales de "alguien lo vio".
  async function autoCerrar(messageId, motivo) {
    const { error } = await supabase
      .from('notificaciones_sucursal')
      .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: motivo })
      .eq('source', 'discord')
      .eq('external_ref', messageId)
      .is('acknowledged_at', null);
    if (error) console.error('Error auto-cerrando alerta de Discord:', error);
  }

  // Nunca dejar que un error del bot tumbe el proceso entero — este mismo
  // proceso también sirve el dashboard y la API, así que un bug acá no debe
  // afectar nada más.
  client.on('error', (err) => {
    console.error('Error del cliente de Discord (no fatal):', err.message);
  });

  client.once('clientReady', () => {
    console.log(`Bot de Discord conectado como ${client.user.tag}`);
  });

  client.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;
      if (!Object.prototype.hasOwnProperty.call(channelMap, message.channelId)) return;

      // Un reply es una señal de "alguien lo vio" — cierra la alerta del
      // mensaje original en vez de (o además de) crear una nueva.
      if (message.reference?.messageId) {
        await autoCerrar(message.reference.messageId, 'auto:discord_reply');
      }

      if (!message.content) return; // ignora mensajes solo con adjuntos/embeds por ahora

      const sucursal_id = channelMap[message.channelId] || null;
      const text = `${message.author.username}: ${message.content}`.slice(0, 300);

      const { error } = await supabase
        .from('notificaciones_sucursal')
        .insert({ sucursal_id, source: 'discord', text, external_ref: message.id });
      if (error) console.error('Error guardando mensaje de Discord:', error);
      else enviarPush(supabase, sucursal_id, { title: 'Discord', body: text, url: '/' }).catch(() => {});
    } catch (err) {
      console.error('Error procesando mensaje de Discord (no fatal):', err.message);
    }
  });

  client.on('messageReactionAdd', async (reaction, user) => {
    try {
      if (user.bot) return;
      if (!Object.prototype.hasOwnProperty.call(channelMap, reaction.message.channelId)) return;
      await autoCerrar(reaction.message.id, 'auto:discord_reaction');
    } catch (err) {
      console.error('Error procesando reacción de Discord (no fatal):', err.message);
    }
  });

  client.login(token).catch((err) => {
    console.error('No se pudo conectar el bot de Discord:', err.message);
  });
}

module.exports = { startDiscordBot };
