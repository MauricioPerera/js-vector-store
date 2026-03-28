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
  normalize,
} = require('../../js-vector-store.js');

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

// ─── Main handler ──────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Auth
    const token = env.API_TOKEN;
    if (token) {
      const auth = request.headers.get('Authorization');
      if (!auth || auth !== `Bearer ${token}`) {
        return err('Unauthorized', 401);
      }
    }

    const method = request.method;
    const { parts } = parseRoute(request.url);
    const storeType = (env.STORE_TYPE || 'binary').toLowerCase();
    const dim = parseInt(env.DIMENSIONS || '768', 10);
    const prefix = '';

    // ── Route: GET / ─────────────────────────────────────────
    if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) {
      return ok({
        service: 'js-vector-server',
        version: '1.0.0',
        storeType,
        dimensions: dim,
      });
    }

    // All routes under /v1/...
    if (parts[0] !== 'v1') return err('Not found', 404);

    // ── Route: GET /v1/stats ─────────────────────────────────
    if (parts[1] === 'stats' && method === 'GET') {
      const collections = await listCollections(env.VECTOR_KV, prefix, storeType);
      const ext = fileExtensions(storeType);
      const stats = {};
      for (const col of collections) {
        const manifest = await env.VECTOR_KV.get(prefix + col + ext.json, 'json');
        stats[col] = { count: manifest?.ids?.length || 0, dim };
      }
      return ok({ storeType, dimensions: dim, collections: stats });
    }

    // ── Route: GET /v1/collections ───────────────────────────
    if (parts[1] === 'collections' && parts.length === 2 && method === 'GET') {
      const collections = await listCollections(env.VECTOR_KV, prefix, storeType);
      return ok({ collections });
    }

    // ── Route: POST /v1/search-across ────────────────────────
    if (parts[1] === 'search-across' && method === 'POST') {
      const body = await readBody(request);
      if (!body || !body.vector || !body.collections) {
        return err('Required: vector, collections', 400);
      }
      const adapter = new CloudflareKVAdapter(env.VECTOR_KV, prefix);
      const ext = fileExtensions(storeType);
      const files = [];
      for (const col of body.collections) {
        files.push(col + ext.bin, col + ext.json);
      }
      await adapter.preload(files);
      const store = createStore(adapter, storeType, dim);
      const results = store.searchAcross(
        body.collections, body.vector, body.limit || 5, body.metric || 'cosine'
      );
      return ok({ results });
    }

    // ── Collection routes: /v1/collections/:col/... ──────────
    if (parts[1] !== 'collections' || !parts[2]) return err('Not found', 404);

    const col = parts[2];
    const ext = fileExtensions(storeType);
    const adapter = new CloudflareKVAdapter(env.VECTOR_KV, prefix);
    await adapter.preload([col + ext.bin, col + ext.json]);
    const store = createStore(adapter, storeType, dim);

    let mutated = false;

    try {
      // ── DELETE /v1/collections/:col ──────────────────────
      if (parts.length === 3 && method === 'DELETE') {
        store.drop(col);
        store.flush();
        await adapter.deleteFromKV(col + ext.bin);
        await adapter.deleteFromKV(col + ext.json);
        return ok({ dropped: col });
      }

      // ── GET /v1/collections/:col/count ──────────────────
      if (parts[3] === 'count' && method === 'GET') {
        return ok({ collection: col, count: store.count(col) });
      }

      // ── GET /v1/collections/:col/ids ────────────────────
      if (parts[3] === 'ids' && method === 'GET') {
        return ok({ collection: col, ids: store.ids(col) });
      }

      // ── POST /v1/collections/:col/search ────────────────
      if (parts[3] === 'search' && method === 'POST') {
        const body = await readBody(request);
        if (!body || !body.vector) return err('Required: vector', 400);
        const results = store.search(
          col, body.vector, body.limit || 5, body.dimSlice || 0, body.metric || 'cosine'
        );
        return ok({ collection: col, results });
      }

      // ── POST /v1/collections/:col/matryoshka ────────────
      if (parts[3] === 'matryoshka' && method === 'POST') {
        const body = await readBody(request);
        if (!body || !body.vector) return err('Required: vector', 400);
        const results = store.matryoshkaSearch(
          col, body.vector, body.limit || 5,
          body.stages || [128, 384, 768], body.metric || 'cosine'
        );
        return ok({ collection: col, results });
      }

      // ── POST /v1/collections/:col/vectors ───────────────
      if (parts[3] === 'vectors' && !parts[4] && method === 'POST') {
        const body = await readBody(request);
        if (!body || !body.id || !body.vector) return err('Required: id, vector', 400);
        store.set(col, body.id, body.vector, body.metadata || {});
        mutated = true;
        return ok({ collection: col, id: body.id, action: 'set' });
      }

      // ── POST /v1/collections/:col/vectors/batch ─────────
      if (parts[3] === 'vectors' && parts[4] === 'batch' && method === 'POST') {
        const body = await readBody(request);
        if (!body || !Array.isArray(body.vectors)) return err('Required: vectors[]', 400);
        let count = 0;
        for (const v of body.vectors) {
          if (v.id && v.vector) {
            store.set(col, v.id, v.vector, v.metadata || {});
            count++;
          }
        }
        mutated = true;
        return ok({ collection: col, imported: count });
      }

      // ── GET /v1/collections/:col/vectors/:id ────────────
      if (parts[3] === 'vectors' && parts[4] && method === 'GET') {
        const id = decodeURIComponent(parts[4]);
        const item = store.get(col, id);
        if (!item) return err('Vector not found', 404);
        return ok(item);
      }

      // ── DELETE /v1/collections/:col/vectors/:id ─────────
      if (parts[3] === 'vectors' && parts[4] && method === 'DELETE') {
        const id = decodeURIComponent(parts[4]);
        const removed = store.remove(col, id);
        if (!removed) return err('Vector not found', 404);
        mutated = true;
        return ok({ collection: col, id, action: 'removed' });
      }

      return err('Not found', 404);

    } finally {
      // Persist mutations to KV
      if (mutated) {
        store.flush();
        await adapter.persist();
      }
    }
  },
};
