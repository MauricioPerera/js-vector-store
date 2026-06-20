const http = require("http");
const url = require("url");
const path = require("path");

const { VectorStore, QuantizedStore, BinaryQuantizedStore, BM25Index, HybridSearch, FileStorageAdapter } = require(path.join(__dirname, "js-vector-store.js"));
const { resolveApiRoute } = require(path.join(__dirname, "api-routes.js"));

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "vector-data");
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "embeddinggemma:latest";

const collections = new Map();
const bm25s = new Map();

async function generateEmbedding(text) {
  const res = await fetch(OLLAMA_HOST + "/api/embeddings", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  return (await res.json()).embedding;
}

function getCollection(name, dim = 768, backend = "float32") {
  if (collections.has(name)) return collections.get(name);
  const dir = path.join(DATA_DIR, name);
  let store;
  if (backend === "binary") store = new BinaryQuantizedStore(new FileStorageAdapter(dir), dim);
  else if (backend === "int8") store = new QuantizedStore(new FileStorageAdapter(dir), dim);
  else store = new VectorStore(new FileStorageAdapter(dir), dim);
  collections.set(name, store);
  return store;
}

function getBM25(name) {
  if (!bm25s.has(name)) bm25s.set(name, new BM25Index());
  return bm25s.get(name);
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data, null, 2));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body); } catch { return {}; }
}

// ─── Handlers (acción -> función). Comparten el estado de módulo (collections, bm25s, …).
// Las rutas de colección reciben `store` ya resuelto por el dispatcher. ────────────────────

function aHealth(req, res) {
  return send(res, 200, { status: "ok", api: "js-vector-store-headless", ollama: OLLAMA_MODEL });
}

function aList(req, res) {
  const result = [];
  for (const [name, store] of collections) {
    const ids = store.ids(name);
    result.push({ name, count: ids.length, dimension: store.dim || store.dimension, backend: store.constructor.name });
  }
  return send(res, 200, { collections: result });
}

async function aIndex(req, res, route, query, store) {
  const body = await readBody(req);
  const embedding = body.vector || await generateEmbedding(body.text);
  store.set(route.colName, body.id, embedding, body.metadata || {});
  store.flush();
  const bm25 = bm25s.get(route.colName);
  if (bm25 && body.text) bm25.addDocument(route.colName, body.id, body.text);
  return send(res, 201, { indexed: body.id, dim: embedding.length });
}

async function aSearchEmpty(res, store, colName) {
  const ids = store.ids(colName);
  return send(res, 200, { collection: colName, count: ids.length, ids: ids.slice(0, 100) });
}

async function runSearchMode(query, store, colName, q) {
  if (query.mode === "bm25") {
    return getBM25(colName).search(colName, q, Number(query.limit) || 10);
  }
  if (query.mode === "hybrid") {
    const bm25 = getBM25(colName);
    const qVec = await generateEmbedding(q);
    return new HybridSearch(store, bm25, "rrf").search(colName, qVec, q, Number(query.limit) || 10);
  }
  const qVec = await generateEmbedding(q);
  return store.search(colName, qVec, Number(query.limit) || 10);
}

async function aSearch(req, res, route, query, store) {
  const q = query.q || query.query;
  if (!q) return aSearchEmpty(res, store, route.colName);
  const results = await runSearchMode(query, store, route.colName, q);
  return send(res, 200, {
    collection: route.colName, query: q, mode: query.mode || "vector",
    results: results.map(r => ({ id: r.id, score: r.score, metadata: r.metadata })),
  });
}

function aGetById(req, res, route, query, store) {
  const doc = store.get(route.colName, route.docId);
  if (!doc) return send(res, 404, { error: "Not found" });
  return send(res, 200, doc);
}

function aDelete(req, res, route, query, store) {
  store.remove(route.colName, route.docId);
  store.flush();
  return send(res, 200, { deleted: route.docId });
}

const API_HANDLERS = {
  health: aHealth, list: aList, index: aIndex, search: aSearch, getById: aGetById, delete: aDelete,
};

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (req.method === "OPTIONS") {
    res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  try {
    const route = resolveApiRoute(req.method, parsed.pathname);
    if (route.action === "notFound") return send(res, 404, { error: "Not found" });
    // Igual que el original: cualquier path de colección obtiene/crea el store antes del dispatch.
    const store = route.colName ? getCollection(route.colName) : null;
    if (route.action === "methodNotAllowed") return send(res, 405, { error: "Method not allowed" });
    return await API_HANDLERS[route.action](req, res, route, parsed.query, store);
  } catch (err) {
    console.error("API Error:", err.message);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Vector Store API running on http://localhost:${PORT}`);
  console.log("Endpoints:");
  console.log("  GET  /health                     - Health check");
  console.log("  GET  /collections                - List collections");
  console.log("  POST /collections/:name           - Index document (body: {id, text, vector?, metadata?})");
  console.log("  GET  /collections/:name?q=...   - Search (mode=vector|bm25|hybrid)");
  console.log("  GET  /collections/:name/:id     - Get document");
  console.log("  DELETE /collections/:name/:id   - Delete document");
});
