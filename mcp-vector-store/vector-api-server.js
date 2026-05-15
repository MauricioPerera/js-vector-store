const http = require("http");
const url = require("url");
const path = require("path");

const { VectorStore, QuantizedStore, BinaryQuantizedStore, BM25Index, HybridSearch, FileStorageAdapter } = require(path.join(__dirname, "js-vector-store.js"));

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

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  if (req.method === "OPTIONS") {
    res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  try {
    // Health
    if (pathname === "/health") return send(res, 200, { status: "ok", api: "js-vector-store-headless", ollama: OLLAMA_MODEL });

    // List collections
    if (pathname === "/collections") {
      const result = [];
      for (const [name, store] of collections) {
        const ids = store.ids(name);
        result.push({ name, count: ids.length, dimension: store.dim || store.dimension, backend: store.constructor.name });
      }
      return send(res, 200, { collections: result });
    }

    const m = pathname.match(/^\/collections\/([^\/]+)(?:\/([^\/]+))?$/);
    if (!m) return send(res, 404, { error: "Not found" });

    const [, colName, docId] = m;
    const store = getCollection(colName);

    // POST /collections/:name - index text with embedding
    if (req.method === "POST" && !docId) {
      const body = await readBody(req);
      const embedding = body.vector || await generateEmbedding(body.text);
      store.set(colName, body.id, embedding, body.metadata || {});
      store.flush();
      const bm25 = bm25s.get(colName);
      if (bm25 && body.text) bm25.addDocument(colName, body.id, body.text);
      return send(res, 201, { indexed: body.id, dim: embedding.length });
    }

    // GET /collections/:name - search
    if (req.method === "GET" && !docId) {
      const q = query.q || query.query;
      if (!q) {
        const ids = store.ids(colName);
        return send(res, 200, { collection: colName, count: ids.length, ids: ids.slice(0, 100) });
      }
      let results;
      if (query.mode === "bm25") {
        const bm25 = getBM25(colName);
        results = bm25.search(colName, q, Number(query.limit) || 10);
      } else if (query.mode === "hybrid") {
        const bm25 = getBM25(colName);
        const qVec = await generateEmbedding(q);
        const hybrid = new HybridSearch(store, bm25, "rrf");
        results = hybrid.search(colName, qVec, q, Number(query.limit) || 10);
      } else {
        const qVec = await generateEmbedding(q);
        results = store.search(colName, qVec, Number(query.limit) || 10);
      }
      return send(res, 200, { collection: colName, query: q, mode: query.mode || "vector", results: results.map(r => ({ id: r.id, score: r.score, metadata: r.metadata })) });
    }

    // GET /collections/:name/:id - get by id
    if (req.method === "GET" && docId) {
      const doc = store.get(colName, docId);
      if (!doc) return send(res, 404, { error: "Not found" });
      return send(res, 200, doc);
    }

    // DELETE /collections/:name/:id
    if (req.method === "DELETE" && docId) {
      store.remove(colName, docId);
      store.flush();
      return send(res, 200, { deleted: docId });
    }

    return send(res, 405, { error: "Method not allowed" });
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
