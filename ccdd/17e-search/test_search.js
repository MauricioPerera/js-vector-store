"use strict";
// Tests CONGELADOS de search/matryoshkaSearch de BinaryQuantizedStore (#17). El refactor extrae
// un scorer compartido (_scorer); la aritmética y el orden no cambian. Equivalencia EXACTA contra
// oráculos (copia de la lógica ORIGINAL) sobre un store real, cubriendo: binario (cosine), general
// (euclidean/dot), con y sin filtro, dimSlice y stages variados. Determinista (sin RNG).

const assert = require("assert");
const {
  BinaryQuantizedStore, MemoryStorageAdapter,
  TopKHeap, normalize, computeScore, matchFilter,
} = require("../../js-vector-store.js");

// --- Oráculos: lógica ORIGINAL (antes del refactor) ------------------------------------------
function searchOracle(store, col, query, limit, dimSlice, metric, filter) {
  const entry = store._load(col);
  if (entry.pending.length > 0) store._flushCol(col, entry);
  const dims = dimSlice > 0 ? Math.min(dimSlice, store.dim) : store.dim;
  const n = entry.ids.length;
  const heap = new TopKHeap(limit);
  if (metric === "cosine" && entry.bin) {
    const qBin = BinaryQuantizedStore.quantize(query, store.dim);
    const u8 = new Uint8Array(entry.bin);
    const bpv = store._bpv;
    for (let i = 0; i < n; i++) {
      if (filter && !matchFilter(entry.meta[i], filter)) continue;
      const score = BinaryQuantizedStore.binaryCosineSim(qBin, 0, u8, i * bpv, dims);
      heap.push({ id: entry.ids[i], score, metadata: entry.meta[i] });
    }
  } else {
    const qNorm = normalize(query);
    for (let i = 0; i < n; i++) {
      if (filter && !matchFilter(entry.meta[i], filter)) continue;
      const vec = store._readVec(col, i);
      const score = computeScore(qNorm, vec, dims, metric);
      heap.push({ id: entry.ids[i], score, metadata: entry.meta[i] });
    }
  }
  return heap.sorted();
}

function matryoshkaOracle(store, col, query, limit, stages, metric) {
  const entry = store._load(col);
  if (entry.ids.length === 0) return [];
  if (entry.pending.length > 0) store._flushCol(col, entry);
  const factor = 4;
  const useBinary = metric === "cosine" && entry.bin;
  const qBin = useBinary ? BinaryQuantizedStore.quantize(query, store.dim) : null;
  const qNorm = useBinary ? null : normalize(query);
  const u8 = useBinary ? new Uint8Array(entry.bin) : null;
  const bpv = store._bpv;
  let candidates = entry.ids.map((id, i) => ({ id, idx: i, metadata: entry.meta[i] }));
  for (let s = 0; s < stages.length; s++) {
    const dims = Math.min(stages[s], store.dim);
    const keepN = s < stages.length - 1 ? Math.max(limit * factor * (stages.length - s), limit) : limit;
    const heap = new TopKHeap(keepN);
    for (const c of candidates) {
      let score;
      if (useBinary) score = BinaryQuantizedStore.binaryCosineSim(qBin, 0, u8, c.idx * bpv, dims);
      else { const vec = store._readVec(col, c.idx); score = computeScore(qNorm, vec, dims, metric); }
      heap.push({ ...c, score });
    }
    candidates = heap.sorted();
  }
  return candidates.slice(0, limit).map(({ id, score, metadata }) => ({ id, score, metadata }));
}

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIM = 64, N = 30;
function makeStore(seed) {
  const store = new BinaryQuantizedStore(new MemoryStorageAdapter(), DIM);
  const gen = rng(seed);
  for (let i = 0; i < N; i++) {
    const v = new Float32Array(DIM);
    for (let d = 0; d < DIM; d++) v[d] = gen() * 2 - 1;
    store.set("c", "id" + i, v, { grp: i % 3, even: i % 2 === 0 });
  }
  store.flush("c");
  return store;
}
function makeQuery(seed) {
  const gen = rng(seed);
  const v = new Float32Array(DIM);
  for (let d = 0; d < DIM; d++) v[d] = gen() * 2 - 1;
  return v;
}

let pass = 0;
const J = (x) => JSON.stringify(x);

const store = makeStore(7);
const queries = [makeQuery(1), makeQuery(2), makeQuery(3)];
const filters = [null, { grp: 1 }, { even: true }, { grp: { $in: [0, 2] } }];

// --- search ---------------------------------------------------------------------------------
for (const q of queries) {
  for (const metric of ["cosine", "euclidean", "dot"]) {
    for (const dimSlice of [0, 32]) {
      for (const filter of filters) {
        const got = store.search("c", q, 7, dimSlice, metric, filter);
        const exp = searchOracle(store, "c", q, 7, dimSlice, metric, filter);
        assert.strictEqual(J(got), J(exp), `search metric=${metric} dimSlice=${dimSlice} filter=${J(filter)}`);
        pass++;
      }
    }
  }
}

// --- matryoshkaSearch -----------------------------------------------------------------------
for (const q of queries) {
  for (const metric of ["cosine", "euclidean"]) {
    for (const stages of [[16, 32, 64], [64], [8, 64]]) {
      for (const limit of [3, 7]) {
        const got = store.matryoshkaSearch("c", q, limit, stages, metric);
        const exp = matryoshkaOracle(store, "c", q, limit, stages, metric);
        assert.strictEqual(J(got), J(exp), `matryoshka metric=${metric} stages=${J(stages)} limit=${limit}`);
        pass++;
      }
    }
  }
}

console.log(`OK: search/matryoshkaSearch == oráculo en ${pass} configuraciones`);
