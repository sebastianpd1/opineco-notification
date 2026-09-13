const { Client, GatewayIntentBits } = require('discord.js');

// DISCORD_CHANNELS: JSON con mapeo canal -> sucursal, ej.
//   {"123456789012345678": "providencia", "234567890123456789": null}
// null (o el canal ausente del mapa) = no se escucha ese canal.
// Si querés que un canal avise a TODAS las sucursales, usá null como valor.
function parseChannelMap() {
  try {
    return JSON.parse(process.env.DISCORD_CHANNELS || '{}');
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

  client.once('ready', () => {
    console.log(`Bot de Discord conectado como ${client.user.tag}`);
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!(message.channelId in channelMap)) return;

    const sucursal_id = channelMap[message.channelId] || null;
    const text = `${message.author.username}: ${message.content}`.slice(0, 300);
    if (!message.content) return; // ignora mensajes solo con adjuntos/embeds por ahora

    const { error } = await supabase
      .from('notificaciones_sucursal')
      .insert({ sucursal_id, source: 'discord', text });
    if (error) console.error('Error guardando mensaje de Discord:', error);
  });

  client.login(token).catch((err) => {
    console.error('No se pudo conectar el bot de Discord:', err.message);
  });
}

module.exports = { startDiscordBot };
