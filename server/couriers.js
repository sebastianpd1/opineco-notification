// Clasificación de estado para despachos de FileMaker (Starken / Rappi /
// Blue Express) — FileMaker ya consulta cada API por su cuenta y nos manda
// el texto/código crudo tal cual vía PATCH a `pedidos_despachar.estado_envio`.
// Acá solo lo traducimos a 3 baldes para saber en qué widget de la TV va.
//
// Ver conversación con el cliente para el diccionario de estados de cada
// courier (Starken en español largo, Rappi en PascalCase, Blue en códigos
// de 2-3 letras).
// Los valores de `transportista` los manda FileMaker tal cual — confirmado
// que llegan en mayúsculas: STARKEN, RAPPI, BLUE (no "BlueExpress").
const COURIER_ESTADOS = {
  STARKEN: {
    en_transito: ['EN CD', 'EN TRANSITO', 'EN DESTINO'],
    entregado: ['ENTREGADO'],
  },
  RAPPI: {
    en_transito: ['Retirado'],
    entregado: ['Entregado'],
  },
  BLUE: {
    en_transito: ['ASO', 'PUH', 'IC', 'DA', 'LD'],
    entregado: ['DL'],
  },
};

// Sin estado_envio (todavía no hay tracking) o transportista desconocido =
// se trata como pendiente, que es el comportamiento de hoy.
function clasificarEnvio(transportista, estadoEnvio) {
  const cfg = COURIER_ESTADOS[transportista];
  if (!cfg || !estadoEnvio) return 'pendiente';
  if (cfg.entregado.includes(estadoEnvio)) return 'entregado';
  if (cfg.en_transito.includes(estadoEnvio)) return 'en_transito';
  return 'pendiente';
}

module.exports = { COURIER_ESTADOS, clasificarEnvio };
