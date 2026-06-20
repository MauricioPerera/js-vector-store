'use strict';
/**
 * routes.js — enrutado PURO del worker (sin Cloudflare env). Mapea (method, parts) -> handler.
 *
 * Separa la decisión de QUÉ handler corre (testeable en node, determinista) del manejo real
 * (I/O contra KV/vector store), que vive en index.js. fetch() consume `resolveRoute`.
 *
 * `parts` = segmentos del path sin barras extremas, p.ej. '/v1/collections/foo/count'
 *           -> ['v1','collections','foo','count'].
 */

function isRoot(parts) {
  return parts.length === 0 || (parts.length === 1 && parts[0] === '');
}

function isCollection(parts) {
  return parts[0] === 'v1' && parts[1] === 'collections' && !!parts[2];
}

// Tabla declarativa: orden = prioridad. Cada `match(parts)` es una unidad pequeña y testeable.
const ROUTES = [
  // La raíz responde a CUALQUIER método (la versión original no filtra método en `/`).
  { method: '*',      handler: 'root',             match: (p) => isRoot(p) },
  { method: 'GET',    handler: 'stats',            match: (p) => p[0] === 'v1' && p[1] === 'stats' },
  { method: 'GET',    handler: 'listCollections',  match: (p) => p[0] === 'v1' && p[1] === 'collections' && p.length === 2 },
  { method: 'POST',   handler: 'searchAcross',     match: (p) => p[0] === 'v1' && p[1] === 'search-across' },
  { method: 'POST',   handler: 'rerank',           match: (p) => p[0] === 'v1' && p[1] === 'rerank' },
  { method: 'POST',   handler: 'crossModelSearch', match: (p) => p[0] === 'v1' && p[1] === 'cross-model-search' },
  { method: 'DELETE', handler: 'dropCollection',   match: (p) => isCollection(p) && p.length === 3 },
  { method: 'GET',    handler: 'count',            match: (p) => isCollection(p) && p[3] === 'count' },
  { method: 'GET',    handler: 'ids',              match: (p) => isCollection(p) && p[3] === 'ids' },
  { method: 'POST',   handler: 'search',           match: (p) => isCollection(p) && p[3] === 'search' },
  { method: 'POST',   handler: 'matryoshka',       match: (p) => isCollection(p) && p[3] === 'matryoshka' },
  { method: 'POST',   handler: 'setVector',        match: (p) => isCollection(p) && p[3] === 'vectors' && !p[4] },
  { method: 'POST',   handler: 'batchVectors',     match: (p) => isCollection(p) && p[3] === 'vectors' && p[4] === 'batch' },
  { method: 'GET',    handler: 'getVector',        match: (p) => isCollection(p) && p[3] === 'vectors' && !!p[4] },
  { method: 'DELETE', handler: 'deleteVector',     match: (p) => isCollection(p) && p[3] === 'vectors' && !!p[4] },
];

// Nombre del handler para (method, parts), o null si ninguna ruta casa (=> 404).
function resolveRoute(method, parts) {
  for (const r of ROUTES) {
    if ((r.method === '*' || r.method === method) && r.match(parts)) return r.handler;
  }
  return null;
}

module.exports = { resolveRoute, ROUTES, isRoot, isCollection };
