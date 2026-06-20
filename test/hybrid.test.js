"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { lib, vec } = require("./helpers.js");
const { VectorStore, BM25Index, HybridSearch, MemoryStorageAdapter } = lib;

const DIM = 16;

// Monta un store + BM25 con documentos cuyo texto y vector están alineados por id.
function setup() {
  const store = new VectorStore(new MemoryStorageAdapter(), DIM);
  const bm = new BM25Index();
  const docs = [
    ["d1", "vector databases store embeddings"],
    ["d2", "the cat sat on the mat"],
    ["d3", "machine learning with neural networks"],
    ["d4", "quick brown fox jumps high"],
  ];
  docs.forEach(([id, text], i) => {
    store.set("c", id, vec(10 + i, DIM), {});
    bm.addDocument("c", id, text);
  });
  store.flush("c");
  return { store, bm, docs };
}

for (const mode of ["rrf", "weighted"]) {
  test(`HybridSearch(${mode}): devuelve resultados fusionados con score`, () => {
    const { store, bm } = setup();
    const hybrid = new HybridSearch(store, bm, mode);
    const r = hybrid.search("c", vec(10, DIM), "embeddings", 3);
    assert.ok(r.length > 0 && r.length <= 3);
    assert.ok(r.every((x) => typeof x.id === "string" && typeof x.score === "number"));
  });

  test(`HybridSearch(${mode}): el doc con match de texto + vector aparece`, () => {
    const { store, bm } = setup();
    const hybrid = new HybridSearch(store, bm, mode);
    // query alineada con d1 (vector vec(10)) y texto "embeddings" (de d1)
    const r = hybrid.search("c", vec(10, DIM), "embeddings", 4);
    assert.ok(r.some((x) => x.id === "d1"), JSON.stringify(r));
  });
}

test("HybridSearch(weighted): textWeight=0 ~ solo vector", () => {
  const { store, bm } = setup();
  const hybrid = new HybridSearch(store, bm, "weighted");
  // query == vector de d3; con textWeight 0 el top debe ser d3
  const r = hybrid.search("c", vec(12, DIM), "irrelevante", 4, { vectorWeight: 1, textWeight: 0 });
  assert.strictEqual(r[0].id, "d3", JSON.stringify(r));
});
