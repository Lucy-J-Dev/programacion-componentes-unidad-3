// Enrutador de producción (simula el balanceador de carga de Blue/Green)
// Todos los usuarios entran por el puerto público y el enrutador envía cada petición al color activo.
// Cambiar de versión es solo cambiar "activo" en estado/produccion.json: no hay que apagar nada.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { leerConfig, leerEstado, rutas } = require('./comun');

const config = leerConfig('produccion');
const archivoLog = path.join(rutas.logs, 'enrutador.log');

const enrutador = http.createServer((req, res) => {
  // Se lee el estado en cada petición para que el cambio de color sea inmediato
  const estado = leerEstado('produccion');
  const color = estado.activo;
  if (!color || !estado[color]) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: { code: 'SIN_VERSION_ACTIVA', message: 'No hay ninguna versión activa.' } }));
  }
  const destino = estado[color];

  const reenvio = http.request({
    host: 'localhost',
    port: destino.puerto,
    method: req.method,
    path: req.url,
    headers: req.headers
  }, respuesta => {
    res.writeHead(respuesta.statusCode, { ...respuesta.headers, 'X-Color-Activo': color });
    respuesta.pipe(res);
    fs.appendFileSync(archivoLog, JSON.stringify({
      fecha: new Date().toISOString(), color: color, version: destino.version, metodo: req.method, ruta: req.url, codigoHttp: respuesta.statusCode
    }) + '\n');
  });
  reenvio.on('error', error => {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'BAD_GATEWAY', message: 'La versión ' + color + ' no responde.' } }));
    fs.appendFileSync(archivoLog, JSON.stringify({ fecha: new Date().toISOString(), color: color, error: error.message }) + '\n');
  });
  req.pipe(reenvio);
});

enrutador.listen(config.puertoPublico, () => {
  console.log('Enrutador escuchando en http://localhost:' + config.puertoPublico);
});
