// Fase 4: verificación post-despliegue
// Revisa /health, /readiness (dependencias), smoke tests y latencia p95 con errores.
// Uso directo: node verificar.js http://localhost:8080 produccion

const crypto = require('crypto');
const { peticion, leerConfig, leerSecretos, crearRegistro } = require('./comun');

const CANTIDAD_CARGA = 200;
const CONCURRENCIA = 10;

function transaccion(payerId, amount) {
  return {
    transactionId: crypto.randomUUID(),
    amount: amount,
    currency: 'COP',
    payerId: payerId,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  };
}

function percentil(valores, p) {
  const ordenados = [...valores].sort((a, b) => a - b);
  return ordenados[Math.ceil((p / 100) * ordenados.length) - 1];
}

async function verificar(urlBase, ambiente, versionEsperada, registrar) {
  const config = leerConfig(ambiente);
  const clave = leerSecretos(ambiente).CLAVE_API;
  const cabeceras = { 'Content-Type': 'application/json', 'X-Api-Key': clave, 'X-Client-Id': 'verificador' };
  const resultados = [];

  function revisar(nombre, paso, detalle) {
    resultados.push(paso);
    registrar('  [' + (paso ? 'OK' : 'FALLA') + '] ' + nombre + (detalle ? ' -> ' + detalle : ''));
  }

  registrar('Verificando ' + urlBase + ' (ambiente: ' + ambiente + ')');

  // 1. Salud: el proceso está vivo y es la versión correcta
  registrar('1) Endpoint /health');
  const salud = await peticion(urlBase + '/health');
  revisar('Responde 200 y status UP', salud.codigo === 200 && salud.json && salud.json.status === 'UP', 'HTTP ' + salud.codigo);
  if (versionEsperada) {
    revisar('Versión desplegada = ' + versionEsperada, salud.json && salud.json.version === versionEsperada, 'responde ' + (salud.json ? salud.json.version : 'nada'));
  }

  // 2. Preparación: dependencias (configuración, secreto y carpeta de logs)
  registrar('2) Endpoint /readiness y dependencias');
  const listo = await peticion(urlBase + '/readiness');
  revisar('Responde 200 y status READY', listo.codigo === 200, 'HTTP ' + listo.codigo + ' ' + (listo.json ? listo.json.status : ''));
  if (listo.json && listo.json.dependencias) {
    for (const [nombre, estado] of Object.entries(listo.json.dependencias)) {
      revisar('Dependencia ' + nombre, estado === 'OK', estado);
    }
  }

  // 3. Smoke tests: los casos principales del contrato
  registrar('3) Smoke tests');
  const url = urlBase + '/transactions/validate';
  const casos = [
    { nombre: 'Transacción válida', esperado: 200, opciones: { metodo: 'POST', headers: cabeceras, cuerpo: transaccion('USR-10001', 1000) } },
    { nombre: 'Datos inválidos (monto negativo)', esperado: 400, opciones: { metodo: 'POST', headers: cabeceras, cuerpo: transaccion('USR-10001', -5) } },
    { nombre: 'Fondos insuficientes', esperado: 409, opciones: { metodo: 'POST', headers: cabeceras, cuerpo: transaccion('USR-20002', 50000) } },
    { nombre: 'Sin clave X-Api-Key', esperado: 401, opciones: { metodo: 'POST', headers: { 'Content-Type': 'application/json' }, cuerpo: transaccion('USR-10001', 1000) } },
    { nombre: 'Ruta inexistente', esperado: 404, opciones: { metodo: 'GET' }, ruta: urlBase + '/no-existe' }
  ];
  // La feature flag solo se prueba donde está encendida
  if (config.flags.limiteMonto) {
    casos.push({ nombre: 'Flag limiteMonto: monto mayor a ' + config.montoMaximo, esperado: 409, opciones: { metodo: 'POST', headers: cabeceras, cuerpo: transaccion('USR-10001', config.montoMaximo + 1) } });
  }
  for (const caso of casos) {
    const r = await peticion(caso.ruta || url, caso.opciones);
    revisar(caso.nombre + ' (espera ' + caso.esperado + ')', r.codigo === caso.esperado, 'HTTP ' + r.codigo + ', ' + r.ms.toFixed(1) + ' ms');
  }

  // 4. Latencia p95 y errores con varias peticiones seguidas
  registrar('4) Latencia y errores (' + CANTIDAD_CARGA + ' peticiones, ' + CONCURRENCIA + ' a la vez)');
  const tiempos = [];
  let errores = 0;
  let enviadas = 0;
  async function trabajador() {
    while (enviadas < CANTIDAD_CARGA) {
      enviadas++;
      const r = await peticion(url, { metodo: 'POST', headers: cabeceras, cuerpo: transaccion('USR-99102', 1000) });
      tiempos.push(r.ms);
      if (r.codigo !== 200) errores++;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCIA }, trabajador));
  const p50 = percentil(tiempos, 50);
  const p95 = percentil(tiempos, 95);
  const promedio = tiempos.reduce((a, b) => a + b, 0) / tiempos.length;
  registrar('  Promedio: ' + promedio.toFixed(1) + ' ms | p50: ' + p50.toFixed(1) + ' ms | p95: ' + p95.toFixed(1) + ' ms | errores: ' + errores + ' de ' + tiempos.length);
  revisar('p95 menor a ' + config.criterios.p95MaximoMs + ' ms', p95 < config.criterios.p95MaximoMs, p95.toFixed(1) + ' ms');
  revisar('Errores <= ' + config.criterios.erroresPermitidos, errores <= config.criterios.erroresPermitidos, errores + ' errores');

  const aprobado = resultados.every(r => r);
  registrar('Resultado de la verificación: ' + (aprobado ? 'APROBADA' : 'NO APROBADA') + ' (' + resultados.filter(r => r).length + '/' + resultados.length + ' revisiones OK)');
  return { aprobado, p95, errores };
}

module.exports = { verificar };

// Si se ejecuta directamente desde la terminal
if (require.main === module) {
  const [urlBase, ambiente] = process.argv.slice(2);
  if (!urlBase || !ambiente) {
    console.log('Uso: node verificar.js <url> <staging|produccion>');
    process.exit(1);
  }
  verificar(urlBase, ambiente, null, crearRegistro('verificacion-manual')).then(r => process.exit(r.aprobado ? 0 : 1));
}
