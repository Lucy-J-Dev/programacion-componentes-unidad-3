// Funciones compartidas por los scripts de despliegue (empaquetar, desplegar, verificar, revertir...)

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const RAIZ = __dirname;
const rutas = {
  app: path.join(RAIZ, 'app'),
  repositorio: path.join(RAIZ, 'repositorio-artefactos'),
  instancias: path.join(RAIZ, 'instancias'),
  estado: path.join(RAIZ, 'estado'),
  evidencias: path.join(RAIZ, 'evidencias'),
  logs: path.join(RAIZ, 'logs'),
  config: path.join(RAIZ, 'config'),
  secretos: path.join(RAIZ, 'secretos')
};
for (const carpeta of ['repositorio', 'instancias', 'estado', 'evidencias', 'logs']) {
  fs.mkdirSync(rutas[carpeta], { recursive: true });
}

// Devuelve una función que escribe en pantalla y también en evidencias/<nombre>.log
function crearRegistro(nombre) {
  const archivo = path.join(rutas.evidencias, nombre + '.log');
  const registrar = (texto = '') => {
    console.log(texto);
    fs.appendFileSync(archivo, texto + '\n');
  };
  registrar('');
  registrar('===== node ' + process.argv.slice(1).map(a => path.basename(a)).join(' ') + ' =====');
  return registrar;
}

function leerConfig(ambiente) {
  return JSON.parse(fs.readFileSync(path.join(rutas.config, ambiente + '.json'), 'utf8'));
}

// Lee un archivo .env sencillo (CLAVE=valor). Los secretos nunca se muestran en pantalla.
function leerSecretos(ambiente) {
  const secretos = {};
  const texto = fs.readFileSync(path.join(rutas.secretos, ambiente + '.env'), 'utf8');
  for (const linea of texto.split(/\r?\n/)) {
    if (linea.trim() === '' || linea.trim().startsWith('#')) continue;
    const posicion = linea.indexOf('=');
    secretos[linea.slice(0, posicion).trim()] = linea.slice(posicion + 1).trim();
  }
  return secretos;
}

// Estado del ambiente: qué color está activo y qué versión tiene cada uno
function leerEstado(ambiente) {
  const archivo = path.join(rutas.estado, ambiente + '.json');
  if (!fs.existsSync(archivo)) return { activo: null, anterior: null, azul: null, verde: null, enrutadorPid: null };
  return JSON.parse(fs.readFileSync(archivo, 'utf8'));
}

function guardarEstado(ambiente, estado) {
  fs.writeFileSync(path.join(rutas.estado, ambiente + '.json'), JSON.stringify(estado, null, 2));
}

// Hace una petición HTTP y mide cuánto tarda
function peticion(url, opciones = {}) {
  return new Promise(resolve => {
    const inicio = process.hrtime.bigint();
    const req = http.request(url, { method: opciones.metodo || 'GET', headers: opciones.headers || {}, timeout: opciones.timeout || 5000 }, res => {
      let cuerpo = '';
      res.on('data', parte => { cuerpo += parte; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(cuerpo); } catch (e) { json = null; }
        resolve({ codigo: res.statusCode, json: json, headers: res.headers, ms: Number(process.hrtime.bigint() - inicio) / 1e6 });
      });
    });
    req.on('timeout', () => req.destroy(new Error('tiempo de espera agotado')));
    req.on('error', error => resolve({ codigo: 0, json: null, headers: {}, error: error.message, ms: Number(process.hrtime.bigint() - inicio) / 1e6 }));
    if (opciones.cuerpo !== undefined) req.write(typeof opciones.cuerpo === 'string' ? opciones.cuerpo : JSON.stringify(opciones.cuerpo));
    req.end();
  });
}

const esperar = ms => new Promise(resolve => setTimeout(resolve, ms));

// Espera hasta que /health responda (máximo unos 10 segundos)
async function esperarSalud(urlBase) {
  for (let intento = 1; intento <= 20; intento++) {
    const r = await peticion(urlBase + '/health', { timeout: 1000 });
    if (r.codigo === 200) return true;
    await esperar(500);
  }
  return false;
}

function procesoVivo(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function detenerProceso(pid) {
  if (procesoVivo(pid)) process.kill(pid);
}

// Arranca un script de Node en segundo plano (sigue vivo cuando termina el script que lo lanzó)
function iniciarProceso(script, variables, nombreSalida) {
  const salida = fs.openSync(path.join(rutas.logs, nombreSalida + '.salida.log'), 'a');
  const hijo = spawn(process.execPath, [script], {
    detached: true,
    stdio: ['ignore', 'ignore', salida],
    env: { ...process.env, ...variables },
    windowsHide: true
  });
  hijo.unref();
  fs.closeSync(salida);
  return hijo.pid;
}

module.exports = {
  rutas, crearRegistro, leerConfig, leerSecretos, leerEstado, guardarEstado,
  peticion, esperar, esperarSalud, procesoVivo, detenerProceso, iniciarProceso
};
