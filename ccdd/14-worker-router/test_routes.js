'use strict';
// Property-test CONGELADO de resolveRoute (issue #14). Oráculo INDEPENDIENTE: reproduce el flujo
// de enrutado ORIGINAL de fetch() en server/src/index.js (cadena de if por path/método), devolviendo
// el nombre de handler. NO importa nada del módulo bajo prueba salvo resolveRoute. Asegura que la
// tabla de rutas es equivalente a la cadena de condicionales que reemplaza.
//
// Casos fijos por ruta + 8000 combinaciones (method, parts) generadas con semilla fija.

const { resolveRoute } = require('../../server/src/routes.js');

// --- Oráculo independiente: cadena de if del fetch() original (solo enrutado por path/método) ---
function oracle(method, parts) {
  const p = parts;
  if (p.length === 0 || (p.length === 1 && p[0] === '')) return 'root';      // L118 (cualquier método)
  if (p[0] !== 'v1') return null;                                            // L128 -> 404
  if (p[1] === 'stats' && method === 'GET') return 'stats';                  // L131 (sin length)
  if (p[1] === 'collections' && p.length === 2 && method === 'GET') return 'listCollections'; // L143
  if (p[1] === 'search-across' && method === 'POST') return 'searchAcross';  // L149
  if (p[1] === 'rerank' && method === 'POST') return 'rerank';               // L171
  if (p[1] === 'cross-model-search' && method === 'POST') return 'crossModelSearch'; // L189
  if (p[1] !== 'collections' || !p[2]) return null;                          // L225 -> 404
  if (p.length === 3 && method === 'DELETE') return 'dropCollection';        // L237
  if (p[3] === 'count' && method === 'GET') return 'count';                  // L246
  if (p[3] === 'ids' && method === 'GET') return 'ids';                      // L251
  if (p[3] === 'search' && method === 'POST') return 'search';               // L256
  if (p[3] === 'matryoshka' && method === 'POST') return 'matryoshka';       // L267
  if (p[3] === 'vectors' && !p[4] && method === 'POST') return 'setVector';  // L278
  if (p[3] === 'vectors' && p[4] === 'batch' && method === 'POST') return 'batchVectors'; // L287
  if (p[3] === 'vectors' && p[4] && method === 'GET') return 'getVector';    // L302
  if (p[3] === 'vectors' && p[4] && method === 'DELETE') return 'deleteVector'; // L310
  return null;                                                              // L318 -> 404
}

let fail = 0;
function check(method, parts, label) {
  const a = resolveRoute(method, parts);
  const b = oracle(method, parts);
  if (a !== b) {
    fail++;
    if (fail <= 15) console.error('DIVERGENCIA', label || '', method, JSON.stringify(parts), 'got', a, 'oracle', b);
  }
}

// --- Casos fijos: una ruta positiva por handler + negativos clave ---------------------------
const fixed = [
  ['GET', []], ['GET', ['']], ['POST', ['']],                         // root (cualquier método)
  ['GET', ['v1', 'stats']], ['GET', ['v1', 'stats', 'x']],            // stats (sin length)
  ['GET', ['v1', 'collections']], ['GET', ['v1', 'collections', 'a']],// listCollections / (len3 GET -> null)
  ['POST', ['v1', 'search-across']], ['POST', ['v1', 'rerank']],
  ['POST', ['v1', 'cross-model-search']],
  ['DELETE', ['v1', 'collections', 'c']],                             // dropCollection
  ['GET', ['v1', 'collections', 'c', 'count']],
  ['GET', ['v1', 'collections', 'c', 'ids']],
  ['POST', ['v1', 'collections', 'c', 'search']],
  ['POST', ['v1', 'collections', 'c', 'matryoshka']],
  ['POST', ['v1', 'collections', 'c', 'vectors']],                    // setVector
  ['POST', ['v1', 'collections', 'c', 'vectors', 'batch']],           // batchVectors
  ['GET', ['v1', 'collections', 'c', 'vectors', 'id1']],              // getVector
  ['DELETE', ['v1', 'collections', 'c', 'vectors', 'id1']],           // deleteVector
  ['POST', ['v1', 'collections', 'c', 'vectors', 'id1']],             // null (POST con id != batch)
  ['GET', ['v1', 'unknown']], ['POST', ['v1', 'stats']],              // null
  ['GET', ['other']], ['PUT', ['v1', 'collections', 'c']],            // null
];
fixed.forEach(([m, p], i) => check(m, p, `fixed#${i}`));

// --- Generación aleatoria con semilla fija ---------------------------------------------------
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20240614);
const pick = (a) => a[Math.floor(rand() * a.length)];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const SEG = ['v1', 'collections', 'stats', 'search-across', 'rerank', 'cross-model-search',
  'count', 'ids', 'search', 'matryoshka', 'vectors', 'batch', 'c', 'id1', '', 'x', 'foo'];

const N = 8000;
for (let i = 0; i < N; i++) {
  const len = Math.floor(rand() * 6);
  const parts = Array.from({ length: len }, () => pick(SEG));
  check(pick(METHODS), parts, `rand#${i}`);
}

if (fail > 0) {
  console.error(`\nFAIL: ${fail} divergencias entre resolveRoute y el oráculo`);
  process.exit(1);
}
console.log(`OK: resolveRoute == oráculo en ${fixed.length} casos fijos + ${N} aleatorios`);
