"use strict";
// Bundle portable (modelo "SQLite"): serializar todo el storage a UN ArrayBuffer, recargarlo
// y consultar idéntico — en memoria o desde una URL. Sin embeddings/red (salvo un http local).
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { VectorStore, QuantizedStore, BinaryQuantizedStore, MemoryStorageAdapter, fetchBundle } = require("../js-vector-store.js");

const DIM = 32;
function rng(s) {
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function vec(seed, dim) { const g = rng(seed * 2654435761); const v = new Float32Array(dim); for (let i = 0; i < dim; i++) v[i] = g() * 2 - 1; return v; }
function populate(store, n, dim) { const out = []; for (let i = 0; i < n; i++) { const v = vec(100 + i, dim); out.push(v); store.set("c", "id" + i, v, { g: i % 3 }); } store.flush("c"); return out; }
const STORES = [["VectorStore", VectorStore], ["QuantizedStore", QuantizedStore], ["BinaryQuantizedStore", BinaryQuantizedStore]];

for (const [name, Store] of STORES) {
  test(`${name}: round-trip por bundle (search idéntico tras recargar)`, () => {
    const adapter = new MemoryStorageAdapter();
    const s = new Store(adapter, DIM);
    populate(s, 40, DIM);

    const bundle = adapter.toBundle();
    assert.ok(bundle instanceof ArrayBuffer && bundle.byteLength > 0);

    const s2 = new Store(MemoryStorageAdapter.fromBundle(bundle), DIM);
    assert.strictEqual(s2.count("c"), 40);

    const q = vec(999, DIM);
    assert.strictEqual(
      JSON.stringify(s.search("c", q, 5)),
      JSON.stringify(s2.search("c", q, 5)),
      "search idéntico tras el round-trip",
    );
  });
}

test("Bundle: store vacío -> bundle válido y recargable", () => {
  const a = new MemoryStorageAdapter();
  const bundle = a.toBundle();
  const a2 = MemoryStorageAdapter.fromBundle(bundle);
  assert.deepStrictEqual(a2.listKeys(), []);
});

test("Bundle: buffer con magic inválido lanza error claro", () => {
  assert.throws(() => MemoryStorageAdapter.fromBundle(new ArrayBuffer(16)), /magic/i);
});

test("fetchBundle: cargar un índice desde una URL y consultar (read-only)", async () => {
  const adapter = new MemoryStorageAdapter();
  const s = new BinaryQuantizedStore(adapter, DIM);
  const vecs = populate(s, 30, DIM);
  const bundle = adapter.toBundle();

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(Buffer.from(bundle));
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const url = `http://localhost:${server.address().port}/index.jvs`;
    const ab = await fetchBundle(url);
    const remote = new BinaryQuantizedStore(MemoryStorageAdapter.fromBundle(ab), DIM);
    assert.strictEqual(remote.count("c"), 30);
    // self-search sobre el índice cargado desde la URL
    assert.strictEqual(remote.search("c", vecs[10], 3)[0].id, "id10");
  } finally {
    server.close();
  }
});

test("fetchBundle: HTTP no-200 lanza error", async () => {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => server.listen(0, r));
  try {
    await assert.rejects(fetchBundle(`http://localhost:${server.address().port}/x`), /HTTP 404/);
  } finally {
    server.close();
  }
});
