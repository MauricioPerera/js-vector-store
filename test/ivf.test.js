"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { lib, vec, populate } = require("./helpers.js");
const { VectorStore, IVFIndex, MemoryStorageAdapter } = lib;

const DIM = 16;

test("IVFIndex: build devuelve {numClusters, numVectors}", () => {
  const store = new VectorStore(new MemoryStorageAdapter(), DIM);
  populate(store, 40, DIM);
  const ivf = new IVFIndex(store, 4, 2);
  const res = ivf.build("c");
  assert.strictEqual(res.numVectors, 40);
  assert.ok(res.numClusters >= 1 && res.numClusters <= 4);
  assert.deepStrictEqual(ivf.indexStats("c"), { numClusters: res.numClusters, numProbes: 2 });
});

test("IVFIndex: probando TODOS los clusters, self-search encuentra el vector exacto", () => {
  const store = new VectorStore(new MemoryStorageAdapter(), DIM);
  const vecs = populate(store, 30, DIM);
  const k = 4;
  // numProbes = numClusters -> búsqueda exhaustiva -> el self-search debe acertar
  const ivf = new IVFIndex(store, k, k);
  ivf.build("c");
  for (const i of [0, 13, 29]) {
    const top = ivf.search("c", vecs[i], 5)[0];
    assert.strictEqual(top.id, "id" + i, `query=id${i} top=${top.id}`);
  }
});

test("IVFIndex: search sin build lanza error claro", () => {
  const store = new VectorStore(new MemoryStorageAdapter(), DIM);
  populate(store, 5, DIM);
  const ivf = new IVFIndex(store, 2, 2);
  assert.throws(() => ivf.search("c", vec(1, DIM), 3), /índice IVF|build/i);
});

test("IVFIndex: search devuelve a lo sumo `limit` ids válidos", () => {
  const store = new VectorStore(new MemoryStorageAdapter(), DIM);
  populate(store, 40, DIM);
  const ivf = new IVFIndex(store, 4, 4);
  ivf.build("c");
  const r = ivf.search("c", vec(123, DIM), 5);
  assert.ok(r.length <= 5);
  const valid = new Set(store.ids("c"));
  for (const x of r) assert.ok(valid.has(x.id));
});
