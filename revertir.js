// Plan de reversión (rollback) de producción
// Devuelve el tráfico al color anterior, que sigue encendido con la versión previa.
// Uso: node revertir.js

const { leerConfig, leerEstado, guardarEstado, peticion, procesoVivo, crearRegistro } = require('./comun');

async function revertir() {
  const registrar = crearRegistro('4-rollback');
  const config = leerConfig('produccion');
  const estado = leerEstado('produccion');
  const actual = estado.activo;
  const destino = actual === 'azul' ? 'verde' : 'azul';

  registrar('== ROLLBACK en producción ==');
  if (!actual || !estado[destino] || !procesoVivo(estado[destino].pid)) {
    registrar('No hay una versión anterior encendida a la cual regresar. No se hizo ningún cambio.');
    process.exit(1);
  }
  registrar('Activo ahora: ' + actual + ' (versión ' + estado[actual].version + ')');
  registrar('Se regresa a: ' + destino + ' (versión ' + estado[destino].version + ')');

  // Antes de cambiar, se confirma que la versión anterior responde bien
  const urlDestino = 'http://localhost:' + estado[destino].puerto;
  const salud = await peticion(urlDestino + '/health');
  const listo = await peticion(urlDestino + '/readiness');
  registrar('Revisión previa de ' + destino + ': /health HTTP ' + salud.codigo + ', /readiness HTTP ' + listo.codigo);
  if (salud.codigo !== 200 || listo.codigo !== 200) {
    registrar('La versión anterior no está sana. Rollback cancelado.');
    process.exit(1);
  }

  const inicio = Date.now();
  estado.activo = destino;
  estado.anterior = actual;
  guardarEstado('produccion', estado);
  registrar('>> CONMUTACIÓN: el tráfico pasa de ' + actual + ' a ' + destino + ' <<');

  // Comprobación por el puerto público: debe contestar la versión anterior
  const publica = await peticion('http://localhost:' + config.puertoPublico + '/version');
  const ok = publica.codigo === 200 && publica.json.version === estado[destino].version;
  registrar('Puerto público responde: versión ' + (publica.json ? publica.json.version : '?') + ', color ' + publica.headers['x-color-activo']);
  registrar('Tiempo de la reversión: ' + (Date.now() - inicio) + ' ms');
  registrar(ok ? 'ROLLBACK EXITOSO.' : 'ROLLBACK CON PROBLEMAS: revisar el enrutador.');
  process.exit(ok ? 0 : 1);
}

revertir();
