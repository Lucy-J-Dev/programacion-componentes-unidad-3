// Apaga todas las instancias y el enrutador, y borra el estado (para empezar de cero)
// Uso: node detener.js

const fs = require('fs');
const path = require('path');
const { rutas, leerEstado, detenerProceso } = require('./comun');

for (const ambiente of ['staging', 'produccion']) {
  const estado = leerEstado(ambiente);
  for (const clave of ['unico', 'azul', 'verde']) {
    if (estado[clave]) detenerProceso(estado[clave].pid);
  }
  detenerProceso(estado.enrutadorPid);
  fs.rmSync(path.join(rutas.estado, ambiente + '.json'), { force: true });
}
console.log('Instancias y enrutador detenidos.');
