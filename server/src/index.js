/**
 * js-vector-server
 * Vector database as a service on Cloudflare Workers
 * Uses js-vector-store with KV persistence
 */

// ─── Inline js-vector-store (bundled at build, or import via path) ─────────
// In production, wrangler bundles this automatically from the relative import.
const {
  VectorStore,
  QuantizedStore,
  BinaryQuantizedStore,
  CloudflareKVAdapter,
  Reranker,
  normalize,
} = require('../../js-vector-store.js');

const { resolveRoute } = require('./routes.js');

// ─── Helpers ───────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function ok(result)       { return json({ success: true, result }); }
function err(msg, status) { return json({ success: false, error: msg }, status); }

function parseRoute(url) {
  const u = new URL(url);
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
  return { parts, path: u.pathname };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ─── Store factory ─────────────────────────────────────────────────────────

function createStore(adapter, type, dim) {
  switch (type) {
    case 'float32': return new VectorStore(adapter, dim);
    case 'int8':    return new QuantizedStore(adapter, dim);
    case 'binary':  return new BinaryQuantizedStore(adapter, dim);
    default:        return new BinaryQuantizedStore(adapter, dim);
  }
}

function fileExtensions(type) {
  switch (type) {
    case 'float32': return { bin: '.bin', json: '.json' };
    case 'int8':    return { bin: '.q8.bin', json: '.q8.json' };
    case 'binary':  return { bin: '.b1.bin', json: '.b1.json' };
    default:        return { bin: '.b1.bin', json: '.b1.json' };
  }
}

// ─── Collection discovery from KV ──────────────────────────────────────────

async function listCollections(kv, prefix, type) {
  const ext = fileExtensions(type);
  const suffix = ext.json;
  const list = await kv.list({ prefix });
  const collections = [];
  for (const key of list.keys) {
    if (key.name.endsWith(suffix)) {
      const col = key.name.slice(prefix.length, -suffix.length);
      if (col) collections.push(col);
    }
  }
  return collections;
}

// ─── CORS / Auth ───────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// Devuelve una Response de error de auth, o null si la petición está autorizada.
function checkAuth(request, env, method, parts) {
  const token = env.API_TOKEN;
  const isRootGet = method === 'GET' && (parts.length === 0 || (parts.length === 1 && parts[0] === ''));
  if (!token || token.trim() === '') {
    return isRootGet ? null : err('Unauthorized: API_TOKEN not configured', 401);
  }
  const auth = request.headers.get('Authorization');
  return (!auth || auth !== `Bearer ${token}`) ? err('Unauthorized', 401) : null;
}

// ─── Handlers de nivel superior ──────────────────────────────────────────────
// Firma uniforme: (request, env, ctx) -> Response. ctx = { storeType, dim, prefix }.

function hRoot(request, env, ctx) {
  return ok({ service: 'js-vector-server', version: '1.0.0', storeType: ctx.storeType, dimensions: ctx.dim });
}

async function hStats(request, env, ctx) {
  const collections = await listCollections(env.VECTOR_KV, ctx.prefix, ctx.storeType);
  const ext = fileExtensions(ctx.storeType);
  const stats = {};
  for (const col of collections) {
    const manifest = await env.VECTOR_KV.get(ctx.prefix + col + ext.json, 'json');
    stats[col] = { count: manifest?.ids?.length || 0, dim: ctx.dim };
  }
  return ok({ storeType: ctx.storeType, dimensions: ctx.dim, collections: stats });
}

async function hListCollections(request, env, ctx) {
  const collections = await listCollections(env.VECTOR_KV, ctx.prefix, ctx.storeType);
  return ok({ collections });
}

async function hSearchAcross(request, env, ctx) {
  const body = await readBody(request);
  if (!body || !body.vector || !body.collections) {
    return err('Required: vector, collections', 400);
  }
  const adapter = new CloudflareKVAdapter(env.VECTOR_KV, ctx.prefix);
  const ext = fileExtensions(ctx.storeType);
  const files = [];
  for (const col of body.collections) {
    files.push(col + ext.bin, col + ext.json);
  }
  await adapter.preload(files);
  const store = createStore(adapter, ctx.storeType, ctx.dim);
  const results = store.searchAcross(
    body.collections, body.vector, body.limit || 5, body.metric || 'cosine'
  );
  return ok({ results });
}

async function hRerank(request, env, ctx) {
  const body = await readBody(request);
  if (!body || !body.query || !body.documents) {
    return err('Required: query (string), documents (string[])', 400);
  }
  const cfAccount = env.CF_ACCOUNT_ID;
  const cfToken   = env.CF_API_TOKEN;
  if (!cfAccount || !cfToken) {
    return err('Reranker requires CF_ACCOUNT_ID and CF_API_TOKEN env vars', 500);
  }
  const reranker = Reranker.cloudflare(cfAccount, cfToken, body.model);
  const ranked = await reranker.rank(body.query, body.documents);
  return ok({ ranked });
}

async function hCrossModelSearch(request, env, ctx) {
  const body = await readBody(request);
  if (!body || !body.queryText || !body.sources) {
    return err('Required: queryText (string), sources ([{collection, queryVector}])', 400);
  }
  const cfAccount = env.CF_ACCOUNT_ID;
  const cfToken   = env.CF_API_TOKEN;
  if (!cfAccount || !cfToken) {
    return err('Reranker requires CF_ACCOUNT_ID and CF_API_TOKEN env vars', 500);
  }
  const reranker = Reranker.cloudflare(cfAccount, cfToken, body.model);
  const adapter = new CloudflareKVAdapter(env.VECTOR_KV, ctx.prefix);
  const ext = fileExtensions(ctx.storeType);
  const files = [];
  for (const s of body.sources) {
    files.push(s.collection + ext.bin, s.collection + ext.json);
  }
  await adapter.preload(files);
  const store = createStore(adapter, ctx.storeType, ctx.dim);

  const sources = body.sources.map(s => ({
    store,
    collection: s.collection,
    queryVector: s.queryVector,
  }));

  const results = await reranker.crossModelSearch(body.queryText, sources, {
    candidatesPerSource: body.candidatesPerSource || 10,
    limit: body.limit || 5,
    textField: body.textField || 'text',
  });

  return ok({ results });
}

const TOP_LEVEL = {
  root: hRoot,
  stats: hStats,
  listCollections: hListCollections,
  searchAcross: hSearchAcross,
  rerank: hRerank,
  crossModelSearch: hCrossModelSearch,
};

// ─── Handlers de colección ───────────────────────────────────────────────────
// Firma uniforme: (c) -> Response, donde c = { store, adapter, col, request, parts }.
// Marcan c.mutated = true cuando cambian datos; el dispatcher persiste en el finally.

async function hDropCollection(c) {
  const ext = fileExtensions(c.storeType);
  c.store.drop(c.col);
  c.store.flush();
  await c.adapter.deleteFromKV(c.col + ext.bin);
  await c.adapter.deleteFromKV(c.col + ext.json);
  return ok({ dropped: c.col });
}

function hCount(c) {
  return ok({ collection: c.col, count: c.store.count(c.col) });
}

function hIds(c) {
  return ok({ collection: c.col, ids: c.store.ids(c.col) });
}

async function hSearch(c) {
  const body = await readBody(c.request);
  if (!body || !body.vector) return err('Required: vector', 400);
  const results = c.store.search(
    c.col, body.vector, body.limit || 5, body.dimSlice || 0,
    body.metric || 'cosine', body.filter || null
  );
  return ok({ collection: c.col, results });
}

async function hMatryoshka(c) {
  const body = await readBody(c.request);
  if (!body || !body.vector) return err('Required: vector', 400);
  const results = c.store.matryoshkaSearch(
    c.col, body.vector, body.limit || 5,
    body.stages || [128, 384, 768], body.metric || 'cosine'
  );
  return ok({ collection: c.col, results });
}

async function hSetVector(c) {
  const body = await readBody(c.request);
  if (!body || !body.id || !body.vector) return err('Required: id, vector', 400);
  c.store.set(c.col, body.id, body.vector, body.metadata || {});
  c.mutated = true;
  return ok({ collection: c.col, id: body.id, action: 'set' });
}

async function hBatchVectors(c) {
  const body = await readBody(c.request);
  if (!body || !Array.isArray(body.vectors)) return err('Required: vectors[]', 400);
  let count = 0;
  for (const v of body.vectors) {
    if (v.id && v.vector) {
      c.store.set(c.col, v.id, v.vector, v.metadata || {});
      count++;
    }
  }
  c.mutated = true;
  return ok({ collection: c.col, imported: count });
}

function hGetVector(c) {
  const id = decodeURIComponent(c.parts[4]);
  const item = c.store.get(c.col, id);
  if (!item) return err('Vector not found', 404);
  return ok(item);
}

async function hDeleteVector(c) {
  const id = decodeURIComponent(c.parts[4]);
  const removed = c.store.remove(c.col, id);
  if (!removed) return err('Vector not found', 404);
  c.mutated = true;
  return ok({ collection: c.col, id, action: 'removed' });
}

const COLLECTION = {
  dropCollection: hDropCollection,
  count: hCount,
  ids: hIds,
  search: hSearch,
  matryoshka: hMatryoshka,
  setVector: hSetVector,
  batchVectors: hBatchVectors,
  getVector: hGetVector,
  deleteVector: hDeleteVector,
};

// Setup del store de la colección + dispatch + persistencia de mutaciones (finally).
async function runCollectionRoute(route, request, env, ctx, parts) {
  const col = parts[2];
  const ext = fileExtensions(ctx.storeType);
  const adapter = new CloudflareKVAdapter(env.VECTOR_KV, ctx.prefix);
  await adapter.preload([col + ext.bin, col + ext.json]);
  const store = createStore(adapter, ctx.storeType, ctx.dim);
  const c = { store, adapter, col, request, parts, storeType: ctx.storeType, mutated: false };
  try {
    return await COLLECTION[route](c);
  } finally {
    if (c.mutated) {
      store.flush();
      await adapter.persist();
    }
  }
}

// ─── Main handler ──────────────────────────────────────────────────────────
// fetch() delgado: CORS -> auth -> resolveRoute (tabla pura) -> handler. El enrutado vive en
// routes.js (testeado); aquí solo se despacha y se hace el I/O contra KV.

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const method = request.method;
    const { parts } = parseRoute(request.url);

    const authError = checkAuth(request, env, method, parts);
    if (authError) return authError;

    const ctx = {
      storeType: (env.STORE_TYPE || 'binary').toLowerCase(),
      dim: parseInt(env.DIMENSIONS || '768', 10),
      prefix: '',
    };

    const route = resolveRoute(method, parts);
    if (route === null) return err('Not found', 404);
    if (TOP_LEVEL[route]) return TOP_LEVEL[route](request, env, ctx);
    return runCollectionRoute(route, request, env, ctx, parts);
  },
};
