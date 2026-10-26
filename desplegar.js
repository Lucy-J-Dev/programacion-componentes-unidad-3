// Fase 3: despliegue Blue/Green
// Uso: node desplegar.js <version> <staging|produccion> [--simular-falla]
//
// En staging se instala la versión en una sola instancia y se verifica.
// En producción la versión nueva se instala en el color libre (azul o verde) mientras el otro
// sigue atendiendo. Solo si pasa la verificación se cambia el tráfico; si no, se cancela.
// --simular-falla arranca la versión nueva sin su secreto, para probar que el despliegue se detiene.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const c = require('./comun');
const { verificar } = require('./verificar');

const [version, ambiente] = process.argv.slice(2);
const simularFalla = process.argv.includes('--simular-falla');
if (!version || !['staging', 'produccion'].includes(ambiente)) {
  console.log('Uso: node desplegar.js <version> <staging|produccion> [--simular-falla]');
  process.exit(1);
}

const registrar = c.crearRegistro(ambiente === 'staging' ? '2-despliegue-staging' : '3-despliegue-produccion');
const config = c.leerConfig(ambiente);
const nombreArtefacto = 'servicio-validacion-' + version + '.tgz';
const rutaArtefacto = path.join(c.rutas.repositorio, nombreArtefacto);

// Comprueba que el artefacto existe y que su huella SHA-256 coincide con la publicada
function revisarArtefacto() {
  if (!fs.existsSync(rutaArtefacto)) {
    registrar('ERROR: no existe ' + nombreArtefacto + ' en el repositorio. Ejecute primero node empaquetar.js');
    process.exit(1);
  }
  const publicada = fs.readFileSync(rutaArtefacto + '.sha256', 'utf8').split(' ')[0];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(rutaArtefacto)).digest('hex');
  registrar('Artefacto: ' + nombreArtefacto);
  registrar('Integridad SHA-256: ' + (publicada === actual ? 'OK (' + actual.slice(0, 16) + '...)' : 'NO COINCIDE'));
  if (publicada !== actual) process.exit(1);
}

// Descomprime el artefacto en instancias/<ambiente>-<color> y lo arranca con su configuración
function instalarYArrancar(color, puerto) {
  const carpeta = path.join(c.rutas.instancias, ambiente + '-' + color);
  fs.rmSync(carpeta, { recursive: true, force: true });
  fs.mkdirSync(carpeta, { recursive: true });
  const relativa = path.relative(carpeta, rutaArtefacto).split(path.sep).join('/');
  execSync('tar -xzf "' + relativa + '"', { cwd: carpeta });
  registrar('Instalado en instancias/' + ambiente + '-' + color + '/package');

  const secretos = simularFalla ? {} : c.leerSecretos(ambiente);
  const variables = {
    ...secretos,
    AMBIENTE: ambiente,
    COLOR: color,
    PUERTO: String(puerto),
    RUTA_CONFIG: path.join(c.rutas.config, ambiente + '.json'),
    CARPETA_LOGS: c.rutas.logs
  };
  if (simularFalla) registrar('(Simulación) La instancia arranca SIN el archivo de secretos');
  const pid = c.iniciarProceso(path.join(carpeta, 'package', 'servidor.js'), variables, ambiente + '-' + color);
  registrar('Proceso iniciado: color ' + color + ', puerto ' + puerto + ', PID ' + pid);
  return pid;
}

async function desplegarStaging() {
  registrar('== Despliegue en STAGING de la versión ' + version + ' ==');
  revisarArtefacto();
  const estado = c.leerEstado('staging');
  if (estado.unico) c.detenerProceso(estado.unico.pid);
  await c.esperar(500);

  const pid = instalarYArrancar('unico', config.puerto);
  const url = 'http://localhost:' + config.puerto;
  if (!await c.esperarSalud(url)) {
    registrar('ERROR: la instancia no respondió a /health');
    process.exit(1);
  }
  c.guardarEstado('staging', { activo: 'unico', unico: { version, puerto: config.puerto, pid } });

  const resultado = await verificar(url, 'staging', version, registrar);
  registrar(resultado.aprobado
    ? 'STAGING OK: la versión ' + version + ' puede pasar a producción.'
    : 'STAGING FALLÓ: la versión ' + version + ' NO debe pasar a producción.');
  process.exit(resultado.aprobado ? 0 : 1);
}

async function desplegarProduccion() {
  registrar('== Despliegue Blue/Green en PRODUCCIÓN de la versión ' + version + ' ==');
  revisarArtefacto();
  const estado = c.leerEstado('produccion');
  const activo = estado.activo;
  const nuevo = activo === 'azul' ? 'verde' : 'azul';
  registrar('Color activo ahora: ' + (activo ? activo + ' (versión ' + estado[activo].version + ')' : 'ninguno (primer despliegue)'));
  registrar('Color donde se instala la versión nueva: ' + nuevo);

  // Si en el color libre quedó una versión vieja, se apaga antes de instalar la nueva
  if (estado[nuevo]) c.detenerProceso(estado[nuevo].pid);
  await c.esperar(500);

  const puerto = config.puertos[nuevo];
  const pid = instalarYArrancar(nuevo, puerto);
  const urlNuevo = 'http://localhost:' + puerto;
  if (!await c.esperarSalud(urlNuevo)) {
    registrar('ERROR: la instancia ' + nuevo + ' no respondió a /health. Despliegue cancelado.');
    c.detenerProceso(pid);
    process.exit(1);
  }

  // Verificación de la versión nueva ANTES de recibir tráfico real
  registrar('');
  registrar('-- Verificación de ' + nuevo + ' antes de cambiar el tráfico --');
  const previa = await verificar(urlNuevo, 'produccion', version, registrar);
  if (!previa.aprobado) {
    c.detenerProceso(pid);
    estado[nuevo] = null;
    c.guardarEstado('produccion', estado);
    registrar('');
    registrar('DESPLIEGUE CANCELADO: la versión ' + version + ' no pasó la verificación y se apagó.');
    registrar('El tráfico sigue en ' + (activo ? activo + ' (versión ' + estado[activo].version + ')' : 'ninguno') + '. Los usuarios no se vieron afectados.');
    process.exit(1);
  }

  // El enrutador (puerto público) se enciende si todavía no está corriendo
  if (!c.procesoVivo(estado.enrutadorPid)) {
    estado.enrutadorPid = c.iniciarProceso(path.join(__dirname, 'enrutador.js'), {}, 'enrutador');
    registrar('Enrutador iniciado en el puerto ' + config.puertoPublico + ' (PID ' + estado.enrutadorPid + ')');
    await c.esperar(800);
  }

  // Conmutación: el enrutador empieza a enviar el tráfico al color nuevo
  estado[nuevo] = { version, puerto, pid };
  estado.anterior = activo;
  estado.activo = nuevo;
  c.guardarEstado('produccion', estado);
  registrar('');
  registrar('>> CONMUTACIÓN: el tráfico pasa de ' + (activo || 'ninguno') + ' a ' + nuevo + ' <<');

  // Verificación después del cambio, a través del puerto público
  const urlPublica = 'http://localhost:' + config.puertoPublico;
  registrar('');
  registrar('-- Verificación post-despliegue por el puerto público --');
  const posterior = await verificar(urlPublica, 'produccion', version, registrar);
  if (!posterior.aprobado && activo) {
    // Reversión automática: se devuelve el tráfico al color anterior, que sigue encendido
    estado.activo = activo;
    estado.anterior = nuevo;
    c.guardarEstado('produccion', estado);
    registrar('ROLLBACK AUTOMÁTICO: el tráfico regresó a ' + activo + ' (versión ' + estado[activo].version + ').');
    process.exit(1);
  }
  if (!posterior.aprobado) {
    registrar('La verificación por el puerto público falló y no hay versión anterior a la cual regresar.');
    process.exit(1);
  }

  registrar('');
  registrar('DESPLIEGUE EXITOSO: producción atiende con la versión ' + version + ' (' + nuevo + ').');
  if (activo) {
    registrar('La versión anterior ' + estado[activo].version + ' sigue encendida en ' + activo + ' para una reversión inmediata (node revertir.js).');
  }
  process.exit(0);
}

(ambiente === 'staging' ? desplegarStaging() : desplegarProduccion()).catch(error => {
  registrar('ERROR inesperado: ' + error.message);
  process.exit(1);
});
