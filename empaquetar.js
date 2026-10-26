// Fase 1: genera el artefacto versionado con "npm pack" y lo publica en repositorio-artefactos/
// Uso: node empaquetar.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { rutas, crearRegistro } = require('./comun');

const registrar = crearRegistro('1-empaquetado');
const version = JSON.parse(fs.readFileSync(path.join(rutas.app, 'package.json'), 'utf8')).version;
const nombreEsperado = 'servicio-validacion-' + version + '.tgz';

// Una versión publicada no se vuelve a sobrescribir: si hay cambios, se sube el número de versión
if (fs.existsSync(path.join(rutas.repositorio, nombreEsperado))) {
  registrar('ERROR: la versión ' + version + ' ya está publicada. Cambie "version" en app/package.json.');
  process.exit(1);
}

const comando = 'npm pack --pack-destination ../repositorio-artefactos';
registrar('Versión a empaquetar: ' + version);
registrar('Comando (dentro de app/): ' + comando);
const nombre = execSync(comando, { cwd: rutas.app, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/).pop();

// Huella SHA-256 para comprobar antes de desplegar que el archivo no cambió
const huella = crypto.createHash('sha256').update(fs.readFileSync(path.join(rutas.repositorio, nombre))).digest('hex');
fs.writeFileSync(path.join(rutas.repositorio, nombre + '.sha256'), huella + '  ' + nombre + '\n');

const contenido = execSync('tar -tzf ' + nombre, { cwd: rutas.repositorio, encoding: 'utf8' }).trim().split(/\r?\n/);
registrar('Artefacto publicado: repositorio-artefactos/' + nombre);
registrar('SHA-256: ' + huella);
registrar('Contenido del artefacto:');
contenido.forEach(archivo => registrar('  - ' + archivo));
registrar('¿Incluye secretos?: ' + (contenido.some(archivo => archivo.includes('.env')) ? 'SÍ (revisar)' : 'NO'));
registrar('');
registrar('Artefactos disponibles en el repositorio:');
fs.readdirSync(rutas.repositorio).filter(a => a.endsWith('.tgz')).forEach(a => registrar('  - ' + a));
