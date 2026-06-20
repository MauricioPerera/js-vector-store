"use strict";
// Correctitud de adapters/flush (originalmente PR #13, issues #8–#12). Reescrito como node:test
// para que entre en la batería de CI. Sin red (mock de KV en memoria).
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  VectorStore, QuantizedStore, BinaryQuantizedStore, PolarQuantizedStore,
  MemoryStorageAdapter, FileStorageAdapter, CloudflareKVAdapter,
} = require("../js-vector-store.js");

const DIM = 16;
const vec = (n) => Float32Array.from({ length: DIM }, (_, i) => Math.sin(n * 7.1 + i));

// ── #11 — FileStorageAdapter.listKeys() descubre archivos en disco ──────────────────────────
test("#11 FileStorageAdapter.listKeys() lista los archivos del directorio", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jvs-fa-"));
  try {
    const a = new FileStorageAdapter(dir);
    assert.deepStrictEqual(a.listKeys(), []);
    a.writeBin("col1.bin", new Uint8Array([1, 2]).buffer);
    a.writeJson("col1.json", { ids: [] });
    a.writeBin("col2.bin", new Uint8Array([3]).buffer);
    const keys = a.listKeys();
    assert.strictEqual(keys.length, 3);
    for (const k of ["col1.bin", "col1.json", "col2.bin"]) assert.ok(keys.includes(k), k);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── #10 — VectorStore.maxCollections se hace cumplir en _load() ─────────────────────────────
test("#10 maxCollections: la N+1 colección lanza error; 0 = sin límite", () => {
  const s = new VectorStore(new MemoryStorageAdapter(), DIM, 2);
  s.set("a", "x", vec(1), {});
  s.set("b", "x", vec(2), {});
  assert.throws(() => s.set("c", "x", vec(3), {}), /maxCollections/);

  const unlimited = new VectorStore(new MemoryStorageAdapter(), DIM, 0);
  for (let i = 0; i < 10; i++) unlimited.set("col" + i, "x", vec(i), {});
  assert.strictEqual(unlimited.collections().length, 10);
});

// ── #12 — remove() no escribe directo; delega la escritura a flush() ───────────────────────
class SpyAdapter extends MemoryStorageAdapter {
  constructor() { super(); this.writeBinCount = 0; }
  writeBin(k, v) { this.writeBinCount++; super.writeBin(k, v); }
}

for (const [name, Store] of [
  ["VectorStore", VectorStore], ["QuantizedStore", QuantizedStore],
  ["BinaryQuantizedStore", BinaryQuantizedStore], ["PolarQuantizedStore", PolarQuantizedStore],
]) {
  test(`#12 ${name}.remove() difiere la escritura a flush()`, () => {
    const a = new SpyAdapter();
    const s = new Store(a, DIM);
    s.set("col", "id1", vec(1), {});
    s.set("col", "id2", vec(2), {});
    s.flush("col");
    const afterFlush = a.writeBinCount;
    s.remove("col", "id1");
    assert.strictEqual(a.writeBinCount, afterFlush, "remove() no debe llamar writeBin");
    assert.ok(!s.has("col", "id1"), "remove() actualiza el estado en memoria igual");
    s.flush("col");
    assert.ok(a.writeBinCount > afterFlush, "flush() tras remove() sí escribe");
  });
}

// ── Mock de KV (en memoria) para CloudflareKVAdapter ────────────────────────────────────────
function mockKV() {
  const data = new Map();
  const puts = [], deletes = [];
  return {
    data, puts, deletes,
    async get(k) { return data.has(k) ? data.get(k) : null; },
    async put(k, v) { puts.push(k); data.set(k, v); },
    async delete(k) { deletes.push(k); data.delete(k); },
    async list({ prefix = "", cursor } = {}) {
      return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

// ── #8 — persist() solo escribe las keys modificadas (dirty tracking) ──────────────────────
test("#8 CloudflareKVAdapter.persist() solo escribe las keys dirty", async () => {
  const kv = mockKV();
  const a = new CloudflareKVAdapter(kv, "vs/");
  a.writeJson("a.json", { v: 1 });
  a.writeJson("b.json", { v: 2 });
  a.writeBin("a.bin", new Uint8Array([1]).buffer);
  await a.persist();
  assert.strictEqual(kv.puts.length, 3, "primera persist escribe las 3 dirty");

  kv.puts.length = 0;
  await a.persist();
  assert.strictEqual(kv.puts.length, 0, "persist sin cambios no escribe");

  kv.puts.length = 0;
  a.writeJson("a.json", { v: 99 });
  await a.persist();
  assert.deepStrictEqual(kv.puts, ["vs/a.json"], "persist solo escribe la key modificada");
});

// ── #9 — delete() + persist() elimina la key de KV (no deja huérfanos) ─────────────────────
test("#9 CloudflareKVAdapter.delete() elimina de KV en persist()", async () => {
  const kv = mockKV();
  const a = new CloudflareKVAdapter(kv, "vs/");
  a.writeJson("a.json", { v: 1 });
  await a.persist();
  assert.ok(kv.data.has("vs/a.json"));

  a.delete("a.json");
  await a.persist();
  assert.ok(!kv.data.has("vs/a.json"), "la key desaparece de KV, no solo de cache");
  assert.ok(kv.deletes.includes("vs/a.json"));
});
