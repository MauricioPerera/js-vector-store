"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { lib } = require("./helpers.js");
const { BM25Index } = lib;

function index() {
  const bm = new BM25Index();
  bm.addDocument("c", "d1", "the quick brown fox jumps over the lazy dog");
  bm.addDocument("c", "d2", "machine learning models need vector embeddings");
  bm.addDocument("c", "d3", "the lazy dog sleeps all day long");
  return bm;
}

test("BM25Index: count y vocabularySize reflejan los documentos", () => {
  const bm = index();
  assert.strictEqual(bm.count("c"), 3);
  assert.ok(bm.vocabularySize("c") > 0);
});

test("BM25Index: search rankea por relevancia de keyword", () => {
  const bm = index();
  const r = bm.search("c", "lazy dog", 3);
  assert.ok(r.length > 0);
  // d1 y d3 contienen "lazy dog"; d2 no debe aparecer por encima de ellos
  const top2 = r.slice(0, 2).map((x) => x.id);
  assert.ok(top2.includes("d1") && top2.includes("d3"), JSON.stringify(r));
  assert.ok(!r.some((x) => x.id === "d2") || r[r.length - 1].id === "d2");
});

test("BM25Index: término único discrimina el documento correcto", () => {
  const bm = index();
  const r = bm.search("c", "embeddings", 3);
  assert.strictEqual(r[0].id, "d2");
});

test("BM25Index: removeDocument lo saca de los resultados", () => {
  const bm = index();
  bm.removeDocument("c", "d2");
  assert.strictEqual(bm.count("c"), 2);
  assert.ok(!bm.search("c", "embeddings", 5).some((x) => x.id === "d2"));
});

test("BM25Index: export/import state preserva el ranking", () => {
  const bm = index();
  const state = bm.exportState("c");
  const bm2 = new BM25Index();
  bm2.importState("c", state);
  assert.deepStrictEqual(
    bm2.search("c", "lazy dog", 3).map((x) => x.id),
    bm.search("c", "lazy dog", 3).map((x) => x.id),
  );
});
