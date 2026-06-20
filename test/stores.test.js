"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { lib, vec, populate, ids } = require("./helpers.js");
const { VectorStore, QuantizedStore, BinaryQuantizedStore, PolarQuantizedStore, MemoryStorageAdapter } = lib;

const DIM = 16;
const STORES = [
  ["VectorStore", VectorStore],
  ["QuantizedStore", QuantizedStore],
  ["BinaryQuantizedStore", BinaryQuantizedStore],
  ["PolarQuantizedStore", PolarQuantizedStore],
];

for (const [name, Store] of STORES) {
  const make = () => new Store(new MemoryStorageAdapter(), DIM);

  test(`${name}: set/count/ids/has`, () => {
    const s = make();
    populate(s, 8, DIM);
    assert.strictEqual(s.count("c"), 8);
    assert.strictEqual(s.ids("c").length, 8);
    assert.ok(s.has("c", "id0"));
    assert.ok(!s.has("c", "nope"));
    assert.strictEqual(s.get("c", "nope"), null);
  });

  test(`${name}: get devuelve {id, vector[dim], metadata}`, () => {
    const s = make();
    s.set("c", "x", vec(1, DIM), { tag: "t" });
    s.flush("c");
    const got = s.get("c", "x");
    assert.strictEqual(got.id, "x");
    assert.strictEqual(got.vector.length, DIM);
    assert.deepStrictEqual(got.metadata, { tag: "t" });
  });

  test(`${name}: self-search -> el propio vector es el top-1 (cosine)`, () => {
    const s = make();
    const vecs = populate(s, 12, DIM);
    for (const i of [0, 5, 11]) {
      const top = s.search("c", vecs[i], 3)[0];
      assert.strictEqual(top.id, "id" + i, `query=id${i} top=${top.id}`);
    }
  });

  test(`${name}: search respeta limit y filtro de metadata`, () => {
    const s = make();
    populate(s, 12, DIM);
    assert.strictEqual(s.search("c", vec(200, DIM), 5).length, 5);
    const filtered = s.search("c", vec(200, DIM), 20, 0, "cosine", { g: 1 });
    assert.ok(filtered.length > 0);
    // todos los resultados deben tener metadata.g === 1
    for (const r of filtered) assert.strictEqual(r.metadata.g, 1);
  });

  test(`${name}: remove y drop`, () => {
    const s = make();
    populate(s, 6, DIM);
    s.remove("c", "id0");
    assert.ok(!s.has("c", "id0"));
    assert.strictEqual(s.count("c"), 5);
    s.drop("c");
    assert.strictEqual(s.count("c"), 0);
  });

  test(`${name}: colección vacía -> search []`, () => {
    const s = make();
    assert.deepStrictEqual(s.search("c", vec(1, DIM), 5), []);
  });

  test(`${name}: search con métricas alternativas devuelve resultados`, () => {
    const s = make();
    populate(s, 10, DIM);
    for (const metric of ["cosine", "euclidean", "dot"]) {
      const r = s.search("c", vec(50, DIM), 3, 0, metric);
      assert.ok(r.length === 3 && r.every((x) => typeof x.score === "number"), metric);
    }
  });
}

test("VectorStore (float32): round-trip exacto del vector", () => {
  const s = new VectorStore(new MemoryStorageAdapter(), DIM);
  const v = vec(7, DIM);
  s.set("c", "x", v, {});
  s.flush("c");
  const got = s.get("c", "x").vector;
  for (let i = 0; i < DIM; i++) assert.ok(Math.abs(got[i] - v[i]) < 1e-6, `dim ${i}`);
});

test("VectorStore: matryoshkaSearch self-search top-1 = self", () => {
  const s = new VectorStore(new MemoryStorageAdapter(), DIM);
  const vecs = populate(s, 12, DIM);
  const top = s.matryoshkaSearch("c", vecs[4], 3, [8, 16])[0];
  assert.strictEqual(top.id, "id4");
});

test("searchAcross: combina varias colecciones", () => {
  const s = new VectorStore(new MemoryStorageAdapter(), DIM);
  s.set("a", "x", vec(1, DIM), {}); s.set("b", "y", vec(2, DIM), {});
  s.flush("a"); s.flush("b");
  const r = s.searchAcross(["a", "b"], vec(1, DIM), 5);
  assert.ok(ids(r).includes("x"));
});
