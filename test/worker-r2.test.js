"use strict";
// Test del Worker R2 (examples/cloudflare-r2/index.js) con un `env` mock de R2. Verifica el camino
// read-from-bundle -> query sin desplegar. El runtime real se valida con `wrangler dev`.
const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { BinaryQuantizedStore, MemoryStorageAdapter } = require("../js-vector-store.js");

const DIM = 64, N = 40;
function rng(s) {
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function buildBundle() {
  const a = new MemoryStorageAdapter();
  const s = new BinaryQuantizedStore(a, DIM);
  const g = rng(1);
  const vecs = [];
  for (let i = 0; i < N; i++) {
    const v = new Float32Array(DIM);
    for (let d = 0; d < DIM; d++) v[d] = g() * 2 - 1;
    vecs.push(v);
    s.set("docs", "id" + i, v, { grp: i % 4 });
  }
  s.flush("docs");
  return { bundle: a.toBundle(), vecs };
}

function mockEnv(bundle, extra = {}) {
  return {
    INDEX_KEY: "index.jvs", DIMENSIONS: String(DIM),
    INDEX: { get: async (k) => (k === "index.jvs" ? { arrayBuffer: async () => bundle } : null) },
    ...extra,
  };
}

async function loadWorker() {
  const url = pathToFileURL(path.join(__dirname, "..", "examples", "cloudflare-r2", "index.js"));
  return (await import(url)).default;
}

test("worker R2: /health responde ok", async () => {
  const worker = await loadWorker();
  const { bundle } = buildBundle();
  const res = await worker.fetch(new Request("https://x/health"), mockEnv(bundle));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true, key: "index.jvs" });
});

test("worker R2: /search carga el bundle de R2 y devuelve el self-search correcto", async () => {
  const worker = await loadWorker();
  const { bundle, vecs } = buildBundle();
  const req = new Request("https://x/search", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vector: Array.from(vecs[10]), limit: 3 }),
  });
  const res = await worker.fetch(req, mockEnv(bundle));
  assert.strictEqual(res.status, 200);
  const { results } = await res.json();
  assert.strictEqual(results.length, 3);
  assert.strictEqual(results[0].id, "id10");
});

test("worker R2: /search aplica filtro de metadata", async () => {
  const worker = await loadWorker();
  const { bundle, vecs } = buildBundle();
  const req = new Request("https://x/search", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vector: Array.from(vecs[0]), limit: 20, filter: { grp: 1 } }),
  });
  const res = await worker.fetch(req, mockEnv(bundle));
  const { results } = await res.json();
  assert.ok(results.length > 0);
  for (const r of results) assert.strictEqual(r.metadata.grp, 1);
});

test("worker R2: errores (sin vector -> 400, ruta desconocida -> 404)", async () => {
  const worker = await loadWorker();
  const { bundle } = buildBundle();
  const bad = await worker.fetch(new Request("https://x/search", { method: "POST", body: "{}" }), mockEnv(bundle));
  assert.strictEqual(bad.status, 400);
  const nf = await worker.fetch(new Request("https://x/nope"), mockEnv(bundle));
  assert.strictEqual(nf.status, 404);
});

test("worker R2: API_TOKEN protege /search", async () => {
  const worker = await loadWorker();
  const { bundle, vecs } = buildBundle();
  const env = mockEnv(bundle, { API_TOKEN: "secret" });
  const body = JSON.stringify({ vector: Array.from(vecs[0]), limit: 2 });
  const noAuth = await worker.fetch(new Request("https://x/search", { method: "POST", body }), env);
  assert.strictEqual(noAuth.status, 401);
  const ok = await worker.fetch(new Request("https://x/search", { method: "POST", headers: { Authorization: "Bearer secret" }, body }), env);
  assert.strictEqual(ok.status, 200);
});
