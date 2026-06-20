"use strict";
// Equivalencia del optimizado _getCandidates (listas invertidas) vs el barrido O(n) ORIGINAL.
// El conjunto de candidatos (y su orden ascendente) debe ser idéntico -> search byte a byte igual.
//   node --test test/ivf-inverted.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const { VectorStore, IVFIndex, MemoryStorageAdapter, euclideanDist } = require("../js-vector-store.js");

function rng(s) {
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function vec(g, dim) {
  const v = new Float32Array(dim);
  for (let d = 0; d < dim; d++) v[d] = g() * 2 - 1;
  return v;
}

// Oráculo: selección de candidatos ORIGINAL (barrido O(n) de assignments).
function oracleCandidates(ivf, idx, query) {
  const dims = idx.sampleDims ?? query.length;
  const cd = idx.centroids.map((c, i) => ({ i, d: euclideanDist(query, c, dims) }));
  cd.sort((a, b) => a.d - b.d);
  const probe = new Set(cd.slice(0, ivf.numProbes).map((x) => x.i));
  const out = [];
  for (let i = 0; i < idx.assignments.length; i++) if (probe.has(idx.assignments[i])) out.push(i);
  return out;
}

test("IVF listas invertidas: candidatos idénticos al barrido O(n) original (500 queries)", () => {
  const DIM = 64, N = 2000;
  const store = new VectorStore(new MemoryStorageAdapter(), DIM);
  const g = rng(1);
  for (let i = 0; i < N; i++) store.set("c", "id" + i, vec(g, DIM), {});
  store.flush("c");
  const ivf = new IVFIndex(store, 40, 6);
  ivf.build("c");
  const idx = ivf._loadIndex("c");

  const gq = rng(99);
  for (let t = 0; t < 500; t++) {
    const q = vec(gq, DIM);
    const got = ivf._getCandidates("c", q).candidateIdxs;
    const exp = oracleCandidates(ivf, idx, q);
    assert.deepStrictEqual(got, exp, `query ${t}`);
  }
});

test("IVF listas invertidas: search exacto sigue acertando el self-search (probes=clusters)", () => {
  const DIM = 32, N = 300;
  const store = new VectorStore(new MemoryStorageAdapter(), DIM);
  const g = rng(7);
  const vecs = [];
  for (let i = 0; i < N; i++) { const v = vec(g, DIM); vecs.push(v); store.set("c", "id" + i, v, {}); }
  store.flush("c");
  const k = 10;
  const ivf = new IVFIndex(store, k, k); // exhaustivo -> exacto
  ivf.build("c");
  for (const i of [0, 150, 299]) {
    assert.strictEqual(ivf.search("c", vecs[i], 3)[0].id, "id" + i);
  }
});
