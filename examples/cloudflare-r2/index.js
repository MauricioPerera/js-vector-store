// Worker de búsqueda vectorial READ-ONLY servido desde R2 — alternativa de costo mínimo a Vectorize.
//
// El índice se construye OFFLINE (build-index.js) y se sube a R2 como un solo .jvs (bundle binario).
// El Worker lo carga una vez por isolate (cache en módulo) y responde queries en memoria. Sin DB,
// sin servidor: solo storage R2 + cómputo del Worker. Determinista, zero-dependency.
//
// Endpoints:  GET /health · POST /search {vector:number[], limit?, collection?, filter?}
import pkg from "../../js-vector-store.js"; // wrangler/esbuild resuelve el CommonJS al bundlear
const { BinaryQuantizedStore, MemoryStorageAdapter } = pkg;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS } });

// Cache del store a nivel de isolate: la 1ª request carga de R2; las siguientes reusan en memoria.
const _cache = new Map();
async function loadStore(env, key, dim) {
  if (_cache.has(key)) return _cache.get(key);
  const obj = await env.INDEX.get(key);
  if (!obj) throw new Error(`índice no encontrado en R2: ${key}`);
  const store = new BinaryQuantizedStore(MemoryStorageAdapter.fromBundle(await obj.arrayBuffer()), dim);
  _cache.set(key, store);
  return store;
}

function unauthorized(request, env) {
  const token = env.API_TOKEN;
  if (!token) return null; // sin token configurado: abierto (útil para pruebas)
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${token}` ? null : json({ error: "Unauthorized" }, 401);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return json({ ok: true, key: env.INDEX_KEY || "index.jvs" });

    const denied = unauthorized(request, env);
    if (denied) return denied;

    try {
      if (pathname === "/search" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body || !Array.isArray(body.vector)) return json({ error: "Required: vector (number[])" }, 400);
        const key = env.INDEX_KEY || "index.jvs";
        const dim = parseInt(env.DIMENSIONS || "256", 10);
        const store = await loadStore(env, key, dim);
        const results = store.search(
          body.collection || "docs", body.vector, body.limit || 10, 0, "cosine", body.filter || null,
        );
        return json({ results });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
