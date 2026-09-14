const { Client, GatewayIntentBits } = require('discord.js');

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
    ],
  });

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
      // DEBUG temporal — sacar una vez confirmado que el mapeo de canales anda bien.
      console.log(`[discord debug] channelId=${message.channelId} enMapa=${Object.prototype.hasOwnProperty.call(channelMap, message.channelId)} bot=${message.author.bot} contenido="${message.content}"`);

      if (message.author.bot) return;
      if (!Object.prototype.hasOwnProperty.call(channelMap, message.channelId)) return;
      if (!message.content) return; // ignora mensajes solo con adjuntos/embeds por ahora

      const sucursal_id = channelMap[message.channelId] || null;
      const text = `${message.author.username}: ${message.content}`.slice(0, 300);

      const { error } = await supabase
        .from('notificaciones_sucursal')
        .insert({ sucursal_id, source: 'discord', text });
      if (error) console.error('Error guardando mensaje de Discord:', error);
    } catch (err) {
      console.error('Error procesando mensaje de Discord (no fatal):', err.message);
    }
  });

  client.login(token).catch((err) => {
    console.error('No se pudo conectar el bot de Discord:', err.message);
  });
}

module.exports = { startDiscordBot };
