// Muestra qué versión está en cada color y cuál recibe el tráfico
// Uso: node estado.js

const { leerConfig, leerEstado, peticion, procesoVivo, crearRegistro } = require('./comun');

async function mostrar() {
  const registrar = crearRegistro('estado');
  const config = leerConfig('produccion');
  const estado = leerEstado('produccion');

  registrar('Estado de PRODUCCIÓN');
  for (const color of ['azul', 'verde']) {
    const instancia = estado[color];
    if (!instancia) {
      registrar('  ' + color.padEnd(6) + '| sin instalar');
      continue;
    }
    const vivo = procesoVivo(instancia.pid);
    registrar('  ' + color.padEnd(6) + '| versión ' + instancia.version + ' | puerto ' + instancia.puerto + ' | ' +
      (vivo ? 'encendido' : 'apagado') + (estado.activo === color ? ' | <- RECIBE EL TRÁFICO' : ''));
  }
  const publica = await peticion('http://localhost:' + config.puertoPublico + '/version');
  registrar('  Puerto público ' + config.puertoPublico + ': ' + (publica.codigo === 200
    ? 'versión ' + publica.json.version + ' (color ' + publica.headers['x-color-activo'] + ')'
    : 'sin respuesta'));
}

mostrar();
