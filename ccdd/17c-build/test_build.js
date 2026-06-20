"use strict";
// Tests CONGELADOS del refactor de build / _dequantizeFlat (#17). El único cambio es extraer la
// dequantización a _dequantizeFlat (early-returns). Se prueba por EQUIVALENCIA contra un oráculo
// (copia de la lógica original) para cada tipo de store, más un smoke de build() end-to-end.

const assert = require("assert");
const {
  VectorStore, QuantizedStore, BinaryQuantizedStore, MemoryStorageAdapter, IVFIndex,
  PolarQuantizedStore,
} = require("../../js-vector-store.js");

// --- Oráculo: dequantización ORIGINAL (3 ramas inline, antes del refactor) -------------------
function dequantizeOracle(store, col, entry, n, dim) {
  let flat;
  if (store instanceof PolarQuantizedStore || store instanceof BinaryQuantizedStore) {
    flat = new Float64Array(n * dim);
    for (let i = 0; i < n; i++) {
      const vec = store._readVec(col, i);
      const iOff = i * dim;
      for (let d = 0; d < dim; d++) flat[iOff + d] = vec[d];
    }
  } else if (store instanceof QuantizedStore) {
    flat = new Float64Array(n * dim);
    const stride = store._stride;
    for (let i = 0; i < n; i++) {
      const offset = i * stride;
      const view = new DataView(entry.bin);
      const min = view.getFloat32(offset, true);
      const max = view.getFloat32(offset + 4, true);
      const int8 = new Int8Array(entry.bin, offset + 8, dim);
      const range = max - min || 1;
      const iOff = i * dim;
      for (let d = 0; d < dim; d++) flat[iOff + d] = ((int8[d] + 128) / 255) * range + min;
    }
  } else {
    flat = new Float64Array(n * dim);
    const f32 = new Float32Array(entry.bin);
    for (let i = 0; i < n * dim; i++) flat[i] = f32[i];
  }
  return flat;
}

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIM = 8, N = 12;
function makeVectors(seed) {
  const gen = rng(seed);
  const vecs = [];
  for (let i = 0; i < N; i++) {
    const v = new Float32Array(DIM);
    for (let d = 0; d < DIM; d++) v[d] = gen() * 2 - 1;
    vecs.push(v);
  }
  return vecs;
}

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };

// --- Equivalencia de _dequantizeFlat por tipo de store ---------------------------------------
function checkStore(StoreClass, label, seed) {
  const store = new StoreClass(new MemoryStorageAdapter(), DIM);
  const vecs = makeVectors(seed);
  vecs.forEach((v, i) => store.set("c", "id" + i, v, {}));
  store.flush("c");
  const entry = store._load("c");
  const idx = new IVFIndex(store, 3, 2);

  const got = idx._dequantizeFlat("c", entry, N, DIM);
  const exp = dequantizeOracle(store, "c", entry, N, DIM);
  ok(got.length === N * DIM, `${label}: longitud del flat`);
  ok(JSON.stringify(Array.from(got)) === JSON.stringify(Array.from(exp)), `${label}: _dequantizeFlat == oráculo`);
}

checkStore(VectorStore, "VectorStore(float32)", 1);
checkStore(QuantizedStore, "QuantizedStore(int8)", 2);
checkStore(BinaryQuantizedStore, "BinaryQuantizedStore", 3);

// --- Smoke de build() end-to-end (con RNG seedeado) ------------------------------------------
{
  const store = new VectorStore(new MemoryStorageAdapter(), DIM);
  makeVectors(99).forEach((v, i) => store.set("c", "id" + i, v, {}));
  store.flush("c");
  const idx = new IVFIndex(store, 3, 2);
  const realRandom = Math.random;
  Math.random = rng(555);
  try {
    const res = idx.build("c");
    ok(res.numVectors === N, "build: numVectors == N");
    ok(res.numClusters >= 1 && res.numClusters <= 3, "build: numClusters en rango");
    // el índice quedó disponible para búsqueda
    const found = idx._loadIndex ? idx._loadIndex("c") : idx._indexes.get("c");
    ok(found && found.assignments && found.assignments.length === N, "build: assignments por vector");
  } finally {
    Math.random = realRandom;
  }
}

console.log(`OK: ${pass} aserciones de build/_dequantizeFlat (#17) pasaron`);
