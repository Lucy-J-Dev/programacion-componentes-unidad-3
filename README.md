# Despliegue Blue/Green del Servicio de Validación de Transacciones

Reto de la Unidad 3 del curso Programación de Componentes e Integraciones (TecMD).
Autora: Lucy Mercedes Jiménez Mejía.

El componente es el servicio de validación de transacciones construido en la Unidad 2. Aquí se despliega de forma controlada con la estrategia Blue/Green: la versión estable (1.0.0) atiende en azul, la versión nueva (1.1.0) se instala y se revisa en verde, y solo entonces los usuarios pasan a verde. Si algo falla, se regresa a azul.

## Antes de empezar

1. Tener Node.js 20 o una versión más reciente. No hay que instalar librerías.
2. Crear las claves de cada ambiente: copiar `secretos/ejemplo.env` como `secretos/staging.env` y como `secretos/produccion.env`, y escribir una clave en cada uno. Las claves reales no están en el repositorio.

Todos los comandos se ejecutan dentro de esta carpeta.

## Pasos

| Paso | Comando | Qué hace |
|---|---|---|
| 1 | `node empaquetar.js` | Crea el artefacto `servicio-validacion-1.1.0.tgz` y su huella SHA-256 en `repositorio-artefactos/` |
| 2 | `node desplegar.js 1.1.0 staging` | Instala la versión en staging (puerto 4001) y la verifica |
| 3 | `node desplegar.js 1.0.0 produccion` | Estado inicial: la versión estable 1.0.0 en azul (puerto 3001) detrás del enrutador (puerto 8080) |
| 4 | `node desplegar.js 1.1.0 produccion --simular-falla` | Prueba de seguridad: la versión nueva arranca sin su clave, no pasa la verificación y los usuarios se quedan en azul |
| 5 | `node desplegar.js 1.1.0 produccion` | Despliegue real: 1.1.0 en verde (puerto 3002), verificación, cambio de tráfico y verificación por el puerto 8080 |
| 6 | `node estado.js` | Muestra qué versión tiene cada color y cuál recibe el tráfico |
| 7 | `node revertir.js` | Rollback: el tráfico vuelve al color anterior (se puede ejecutar otra vez para regresar) |
| 8 | `node detener.js` | Apaga todo y borra el estado |

Los artefactos 1.0.0 y 1.1.0 ya vienen publicados en `repositorio-artefactos/`, así que se puede empezar desde el paso 2. Para repetir el paso 1 hay que borrar antes el artefacto 1.1.0, porque una versión publicada no se sobrescribe.

Verificación manual en cualquier momento: `node verificar.js http://localhost:8080 produccion`

## Estructura

- `app/`: código del servicio (versión 1.1.0). La versión 1.0.0 es el mismo `servidor.js` sin el bloque marcado como novedad de la versión 1.1.0.
- `config/`: configuración de cada ambiente (`staging.json` y `produccion.json`).
- `secretos/`: claves por ambiente (solo se sube la plantilla `ejemplo.env`).
- `repositorio-artefactos/`: artefactos versionados con su huella SHA-256.
- `evidencias/`: registros reales de cada paso del despliegue.
- Scripts: `empaquetar.js`, `desplegar.js`, `verificar.js`, `enrutador.js`, `revertir.js`, `estado.js`, `detener.js` y `comun.js` (funciones compartidas).
