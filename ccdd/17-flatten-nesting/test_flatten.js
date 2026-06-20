"use strict";
// Tests CONGELADOS del aplanado de anidamiento (#17): set (VectorStore), listKeys
// (CloudflareKVAdapter) y _kmeansInit (IVFIndex). El refactor solo aplana anidamiento; estos
// tests prueban que el comportamiento observable NO cambió.
//
// _kmeansInit: equivalencia EXACTA contra un oráculo (copia de la lógica original) con Math.random
// seedeado determinista. set/listKeys: caracterización del comportamiento observable.

const assert = require("assert");
const { VectorStore, MemoryStorageAdapter, CloudflareKVAdapter, IVFIndex } = require("../../js-vector-store.js");

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; };

// ─── set (VectorStore): insertar, sobrescribir pending y sobrescribir commiteado ─────────────
{
  const store = new VectorStore(new MemoryStorageAdapter(), 4);
  store.set("c", "a", [1, 2, 3, 4], { tag: "x" });
  store.set("c", "b", [5, 6, 7, 8], { tag: "y" });
  ok(store.count("c") === 2, "count tras 2 inserts");
  ok(store.ids("c").includes("a") && store.ids("c").includes("b"), "ids incluye a y b");
  ok(JSON.stringify(store.get("c", "a").vector ? Array.from(store.get("c", "a").vector) : store.get("c", "a")).includes("1"), "get a devuelve el vector");

  // sobrescribir 'a' estando aún pending
  store.set("c", "a", [9, 9, 9, 9], { tag: "z" });
  ok(store.count("c") === 2, "count no cambia al sobrescribir");
  const a1 = store.get("c", "a");
  ok(a1.metadata.tag === "z", "metadata actualizada al sobrescribir pending");

  // commit (flush) y luego sobrescribir 'a' commiteado -> camino _writeCommittedVector
  store.flush("c");
  store.set("c", "a", [2, 2, 2, 2], { tag: "w" });
  const a2 = store.get("c", "a");
  ok(a2 && a2.metadata.tag === "w", "metadata actualizada al sobrescribir commiteado");
  ok(store.count("c") === 2, "count sigue 2 tras sobrescribir commiteado");
}

// ─── listKeys (CloudflareKVAdapter): filtro por prefijo + paginación por cursor ──────────────
{
  function mockKV(pages) {
    let i = 0;
    return {
      async list() {
        const p = pages[i] || { keys: [], list_complete: true };
        i++;
        return p;
      },
    };
  }
  // con prefijo: solo claves que empiezan por el prefijo, y se les quita el prefijo
  const kvA = mockKV([
    { keys: [{ name: "px/a" }, { name: "other" }, { name: "px/b" }], list_complete: false, cursor: "C1" },
    { keys: [{ name: "px/c" }], list_complete: true },
  ]);
  const adapterA = new CloudflareKVAdapter(kvA, "px/");
  // listKeys es async
  module.exports.__run = (async () => {
    const keysA = await adapterA.listKeys();
    ok(JSON.stringify(keysA) === JSON.stringify(["a", "b", "c"]), "listKeys: prefijo filtra+recorta y pagina (" + JSON.stringify(keysA) + ")");

    // sin prefijo: todas las claves, sin recortar
    const kvB = mockKV([{ keys: [{ name: "k1" }, { name: "k2" }], list_complete: true }]);
    const adapterB = new CloudflareKVAdapter(kvB, "");
    const keysB = await adapterB.listKeys();
    ok(JSON.stringify(keysB) === JSON.stringify(["k1", "k2"]), "listKeys: sin prefijo devuelve todas");

    runKmeans();
    console.log(`OK: ${pass} aserciones del aplanado (#17) pasaron`);
  })();
}

// ─── _kmeansInit (IVFIndex): equivalencia exacta vs oráculo con Math.random seedeado ─────────
function euclideanDistSq(a, aOff, b, bOff, dim) {
  let s = 0;
  for (let d = 0; d < dim; d++) { const x = a[aOff + d] - b[bOff + d]; s += x * x; }
  return s;
}

// Oráculo: copia EXACTA de la lógica original (triple bucle inline, antes del refactor).
function kmeansInitOracle(flat, n, dim, k) {
  const centroids = new Float64Array(k * dim);
  const first = Math.floor(Math.random() * n);
  for (let d = 0; d < dim; d++) centroids[d] = flat[first * dim + d];
  const dists = new Float64Array(n);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      let minD = Infinity;
      for (let cc = 0; cc < c; cc++) {
        const distSq = euclideanDistSq(flat, i * dim, centroids, cc * dim, dim);
        if (distSq < minD) minD = distSq;
      }
      dists[i] = minD;
      total += minD;
    }
    let r = Math.random() * total;
    let chosen = 0;
    for (let i = 0; i < n; i++) {
      r -= dists[i];
      if (r <= 0) { chosen = i; break; }
    }
    for (let d = 0; d < dim; d++) centroids[c * dim + d] = flat[chosen * dim + d];
  }
  return centroids;
}

function seededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runKmeans() {
  const realRandom = Math.random;
  const idx = Object.create(IVFIndex.prototype); // this con los métodos del prototipo (sin constructor)
  try {
    for (let t = 0; t < 200; t++) {
      const dim = 2 + (t % 5);
      const n = 6 + (t % 7);
      const k = 2 + (t % 4);
      const flat = new Float64Array(n * dim);
      const gen = seededRandom(1000 + t);
      for (let i = 0; i < flat.length; i++) flat[i] = Math.floor(gen() * 100);

      Math.random = seededRandom(7000 + t);
      const got = idx._kmeansInit(flat, n, dim, k);
      Math.random = seededRandom(7000 + t);
      const exp = kmeansInitOracle(flat, n, dim, k);
      ok(JSON.stringify(Array.from(got)) === JSON.stringify(Array.from(exp)), `_kmeansInit == oráculo (caso ${t})`);
    }
  } finally {
    Math.random = realRandom;
  }
}
