// Componente: Servicio de Validación de Transacciones (viene de la Unidad 2)
// Implementa POST /transactions/validate y, para el despliegue, GET /health, /readiness y /version.
// No se ejecuta a mano: lo arranca desplegar.js con las variables de su ambiente.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERSION = require('./package.json').version;
const RUTA = '/transactions/validate';

// Todo lo que cambia entre ambientes llega por variables de entorno (nada queda fijo en el código)
const AMBIENTE = process.env.AMBIENTE || 'local';
const COLOR = process.env.COLOR || 'unico';
const PUERTO = Number(process.env.PUERTO) || 3000;
const CLAVE_API = process.env.CLAVE_API; // secreto: viene del archivo secretos/<ambiente>.env

// Configuración del ambiente (puertos, flags, límites) leída desde config/<ambiente>.json
let config = null;
try {
  config = JSON.parse(fs.readFileSync(process.env.RUTA_CONFIG, 'utf8'));
} catch (e) {
  config = null; // el servicio arranca, pero /readiness avisará que no está listo
}

// Carpeta y archivo donde se guardan los logs
const carpetaLogs = process.env.CARPETA_LOGS || path.join(__dirname, 'logs');
if (!fs.existsSync(carpetaLogs)) fs.mkdirSync(carpetaLogs, { recursive: true });
const archivoLog = path.join(carpetaLogs, AMBIENTE + '-' + COLOR + '.log');

// Usuarios simulados con su saldo disponible (en pesos)
const saldos = {
  'USR-99102': 1000000,
  'USR-10001': 500000,
  'USR-20002': 10000
};

// Transacciones ya procesadas, para no aprobar dos veces la misma
const procesadas = new Set();

const regexUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const regexFecha = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// Log estructurado: una línea JSON por evento, en consola y en archivo
function log(nivel, evento, datos) {
  const registro = {
    fecha: new Date().toISOString(),
    nivel: nivel,
    componente: 'servidor',
    version: VERSION,
    ambiente: AMBIENTE,
    color: COLOR,
    evento: evento,
    ...datos
  };
  const linea = JSON.stringify(registro);
  console.log(linea);
  fs.appendFileSync(archivoLog, linea + '\n');
}

// Envía la respuesta en JSON con el traceId y la versión en los headers
function responder(res, codigoHttp, cuerpo, traceId) {
  res.writeHead(codigoHttp, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Trace-Id': traceId,
    'X-Version': VERSION
  });
  res.end(JSON.stringify(cuerpo, null, 2));
}

// Arma la respuesta de error con la estructura ErrorResponse del contrato
function cuerpoError(codigo, mensaje, detalles, traceId) {
  return {
    error: {
      code: codigo,
      message: mensaje,
      details: detalles,
      traceId: traceId
    }
  };
}

// Revisa las dependencias que el servicio necesita para atender transacciones
function revisarDependencias() {
  let logsEscribibles = true;
  try {
    fs.accessSync(carpetaLogs, fs.constants.W_OK);
  } catch (e) {
    logsEscribibles = false;
  }
  return {
    configuracion: config !== null ? 'OK' : 'FALLA',
    secretoClaveApi: CLAVE_API ? 'OK' : 'FALLA',
    carpetaLogs: logsEscribibles ? 'OK' : 'FALLA'
  };
}

// Revisa que la solicitud cumpla el esquema TransactionRequest
function validarSolicitud(datos) {
  const errores = [];

  if (datos === null || typeof datos !== 'object' || Array.isArray(datos)) {
    return ['El cuerpo debe ser un objeto JSON'];
  }

  const obligatorios = ['transactionId', 'amount', 'currency', 'payerId', 'timestamp'];
  for (const campo of obligatorios) {
    if (datos[campo] === undefined || datos[campo] === null || datos[campo] === '') {
      errores.push(campo + ' es obligatorio');
    }
  }

  if (datos.transactionId !== undefined && datos.transactionId !== null && datos.transactionId !== '') {
    if (typeof datos.transactionId !== 'string' || !regexUUID.test(datos.transactionId)) {
      errores.push('transactionId debe tener formato UUID');
    }
  }

  if (datos.amount !== undefined && datos.amount !== null && datos.amount !== '') {
    if (typeof datos.amount !== 'number' || !Number.isFinite(datos.amount)) {
      errores.push('amount debe ser un número');
    } else if (datos.amount < 1) {
      errores.push('amount debe ser mayor a 0');
    }
  }

  if (datos.currency !== undefined && datos.currency !== null && datos.currency !== '') {
    if (typeof datos.currency !== 'string' || !/^[A-Z]{3}$/.test(datos.currency)) {
      errores.push('currency debe ser un código de 3 letras en mayúscula (ej. COP)');
    }
  }

  if (datos.payerId !== undefined && datos.payerId !== null && datos.payerId !== '') {
    if (typeof datos.payerId !== 'string') {
      errores.push('payerId debe ser texto');
    }
  }

  if (datos.timestamp !== undefined && datos.timestamp !== null && datos.timestamp !== '') {
    if (typeof datos.timestamp !== 'string' || !regexFecha.test(datos.timestamp) || isNaN(Date.parse(datos.timestamp))) {
      errores.push('timestamp debe ser una fecha y hora válida (ej. 2025-01-14T14:25:30Z)');
    }
  }

  return errores;
}

// Reglas del negocio: decide si la transacción se aprueba o se rechaza
async function procesarTransaccion(datos) {
  // Casos especiales solo para pruebas
  if (datos.payerId === 'USR-ERROR') {
    throw new Error('Falla simulada en el servicio de saldos');
  }
  if (datos.payerId === 'USR-LENTO') {
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  if (procesadas.has(datos.transactionId)) {
    return { aprobada: false, motivo: 'La transacción ' + datos.transactionId + ' ya fue procesada.' };
  }
  if (!(datos.payerId in saldos)) {
    return { aprobada: false, motivo: 'El usuario ' + datos.payerId + ' no está registrado.' };
  }
  // Novedad de la versión 1.1.0: límite por transacción controlado con una feature flag
  if (config.flags.limiteMonto && datos.amount > config.montoMaximo) {
    return { aprobada: false, motivo: 'El monto supera el máximo permitido por transacción (' + config.montoMaximo + ').' };
  }
  if (saldos[datos.payerId] < datos.amount) {
    return { aprobada: false, motivo: 'El usuario no tiene fondos suficientes.' };
  }

  saldos[datos.payerId] -= datos.amount;
  procesadas.add(datos.transactionId);
  return { aprobada: true };
}

const servidor = http.createServer((req, res) => {
  const inicio = Date.now();

  // Si el cliente envía un traceId válido se reutiliza; si no, se crea uno nuevo
  const traceRecibido = req.headers['x-trace-id'];
  const traceId = regexUUID.test(traceRecibido || '') ? traceRecibido : crypto.randomUUID();

  // Registra el final de cada solicitud con su código y duración
  res.on('finish', () => {
    log(res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO', 'respuesta_enviada', {
      traceId: traceId,
      metodo: req.method,
      ruta: req.url,
      codigoHttp: res.statusCode,
      duracionMs: Date.now() - inicio
    });
  });

  // Endpoints de salud para el despliegue (no piden clave)
  if (req.method === 'GET' && req.url === '/health') {
    return responder(res, 200, { status: 'UP', version: VERSION, ambiente: AMBIENTE, color: COLOR }, traceId);
  }
  if (req.method === 'GET' && req.url === '/readiness') {
    const dependencias = revisarDependencias();
    const listo = Object.values(dependencias).every(estado => estado === 'OK');
    return responder(res, listo ? 200 : 503, { status: listo ? 'READY' : 'NOT_READY', dependencias: dependencias }, traceId);
  }
  if (req.method === 'GET' && req.url === '/version') {
    return responder(res, 200, { version: VERSION, ambiente: AMBIENTE, color: COLOR, flags: config ? config.flags : null }, traceId);
  }

  let cuerpo = '';
  req.on('data', parte => { cuerpo += parte; });
  req.on('end', async () => {
    // La clave X-Api-Key no se guarda en el log
    log('INFO', 'solicitud_recibida', {
      traceId: traceId,
      metodo: req.method,
      ruta: req.url,
      headers: {
        'content-type': req.headers['content-type'],
        'x-trace-id': req.headers['x-trace-id'],
        'x-client-id': req.headers['x-client-id']
      },
      cuerpo: cuerpo
    });

    try {
      if (req.url !== RUTA) {
        return responder(res, 404, cuerpoError('NOT_FOUND', 'La ruta solicitada no existe.', ['Use POST ' + RUTA], traceId), traceId);
      }
      if (req.method !== 'POST') {
        return responder(res, 405, cuerpoError('METHOD_NOT_ALLOWED', 'Método no permitido.', ['Use POST ' + RUTA], traceId), traceId);
      }
      if (config === null || !CLAVE_API) {
        return responder(res, 503, cuerpoError('NOT_READY', 'El servicio no está listo para atender transacciones.', null, traceId), traceId);
      }
      if (req.headers['x-api-key'] !== CLAVE_API) {
        return responder(res, 401, cuerpoError('UNAUTHORIZED', 'Falta la clave de acceso o no es válida.', ['Envíe el header X-Api-Key'], traceId), traceId);
      }
      if (!(req.headers['content-type'] || '').includes('application/json')) {
        return responder(res, 400, cuerpoError('INVALID_REQUEST', 'Los datos enviados no cumplen el formato requerido.', ['El header Content-Type debe ser application/json'], traceId), traceId);
      }

      let datos;
      try {
        datos = JSON.parse(cuerpo);
      } catch (e) {
        return responder(res, 400, cuerpoError('INVALID_REQUEST', 'Los datos enviados no cumplen el formato requerido.', ['El cuerpo no es un JSON válido'], traceId), traceId);
      }

      const errores = validarSolicitud(datos);
      if (errores.length > 0) {
        log('WARN', 'validacion_fallida', { traceId: traceId, errores: errores });
        return responder(res, 400, cuerpoError('INVALID_REQUEST', 'Los datos enviados no cumplen el formato requerido.', errores, traceId), traceId);
      }

      const resultado = await procesarTransaccion(datos);
      if (!resultado.aprobada) {
        log('WARN', 'transaccion_rechazada', { traceId: traceId, transactionId: datos.transactionId, motivo: resultado.motivo });
        return responder(res, 409, cuerpoError('TRANSACTION_REJECTED', 'La transacción no pudo completarse.', [resultado.motivo], traceId), traceId);
      }

      log('INFO', 'transaccion_aprobada', { traceId: traceId, transactionId: datos.transactionId, amount: datos.amount, currency: datos.currency });
      return responder(res, 200, {
        status: 'APPROVED',
        message: 'La transacción fue procesada correctamente.',
        processedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        traceId: traceId
      }, traceId);
    } catch (error) {
      // El detalle técnico queda en el log, pero no se muestra al cliente
      log('ERROR', 'error_interno', { traceId: traceId, mensaje: error.message });
      return responder(res, 500, cuerpoError('INTERNAL_ERROR', 'Ocurrió un error inesperado al procesar la solicitud.', null, traceId), traceId);
    }
  });
});

servidor.listen(PUERTO, () => {
  log('INFO', 'servicio_iniciado', { puerto: PUERTO, configuracionCargada: config !== null, secretoCargado: Boolean(CLAVE_API) });
});
