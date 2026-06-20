"use strict";
// Property-test CONGELADO de _fuseWeighted (#17). Oráculo INDEPENDIENTE: copia EXACTA de la lógica
// original (min-max normalize + weighted sum). Compara el resultado del método refactorizado contra
// el oráculo en casos fijos (bordes: vacíos, rango 0, ids solapados) + 5000 aleatorios con semilla fija.
// El refactor solo extrae helpers; la aritmética y el orden no cambian -> igualdad EXACTA.

const assert = require("assert");
const { HybridSearch, TopKHeap } = require("../../js-vector-store.js");

// _fuseWeighted no usa `this`; lo invocamos vía el prototipo.
const fuseRefactored = (vec, bm25, limit, vw, tw) =>
  HybridSearch.prototype._fuseWeighted(vec, bm25, limit, vw, tw);

// --- Oráculo: lógica ORIGINAL de _fuseWeighted (antes del refactor) --------------------------
function oracle(vecResults, bm25Scores, limit, vectorWeight, textWeight) {
  let vecMin = Infinity, vecMax = -Infinity;
  for (const r of vecResults) {
    if (r.score < vecMin) vecMin = r.score;
    if (r.score > vecMax) vecMax = r.score;
  }
  const vecRange = vecMax - vecMin;

  let bm25Min = Infinity, bm25Max = -Infinity;
  for (const [, s] of bm25Scores) {
    if (s < bm25Min) bm25Min = s;
    if (s > bm25Max) bm25Max = s;
  }
  const bm25Range = bm25Max - bm25Min;

  const fused = new Map();
  for (const r of vecResults) {
    const normVec = vecRange > 0 ? (r.score - vecMin) / vecRange : 1.0;
    const normBm25 = bm25Scores.has(r.id)
      ? (bm25Range > 0 ? (bm25Scores.get(r.id) - bm25Min) / bm25Range : 1.0)
      : 0;
    fused.set(r.id, { score: vectorWeight * normVec + textWeight * normBm25, metadata: r.metadata });
  }
  for (const [id, bm25Score] of bm25Scores) {
    if (!fused.has(id)) {
      const normBm25 = bm25Range > 0 ? (bm25Score - bm25Min) / bm25Range : 1.0;
      fused.set(id, { score: textWeight * normBm25, metadata: {} });
    }
  }
  const heap = new TopKHeap(limit);
  for (const [id, entry] of fused) {
    heap.push({ id, score: Math.round(entry.score * 1e6) / 1e6, metadata: entry.metadata });
  }
  return heap.sorted();
}

let pass = 0;
function check(vec, bm25, limit, vw, tw, label) {
  const got = fuseRefactored(vec, bm25, limit, vw, tw);
  const exp = oracle(vec, bm25, limit, vw, tw);
  assert.strictEqual(JSON.stringify(got), JSON.stringify(exp), `${label}\n got=${JSON.stringify(got)}\n exp=${JSON.stringify(exp)}`);
  pass++;
}

const V = (id, score, meta = {}) => ({ id, score, metadata: meta });
const M = (pairs) => new Map(pairs);

// --- Casos fijos: bordes ---------------------------------------------------------------------
check([], M([]), 5, 0.5, 0.5, "ambos vacíos");
check([V("a", 1)], M([]), 5, 0.5, 0.5, "solo vector");
check([], M([["a", 2]]), 5, 0.5, 0.5, "solo bm25");
check([V("a", 5), V("b", 5)], M([]), 5, 0.7, 0.3, "vector con scores iguales (rango 0)");
check([V("a", 1), V("b", 3)], M([["b", 4], ["c", 8]]), 5, 0.6, 0.4, "ids solapados + solo-bm25");
check([V("a", 1)], M([["a", 9]]), 5, 1.0, 0.0, "textWeight 0");
check([V("a", -2), V("b", -1)], M([["a", -5]]), 1, 0.5, 0.5, "scores negativos + limit 1");
check([V("a", 1, { t: "x" })], M([["a", 1]]), 5, 0.5, 0.5, "metadata preservada");

// --- Aleatorio con semilla fija --------------------------------------------------------------
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(31337);
const IDS = ["a", "b", "c", "d", "e", "f", "g", "h"];
const rscore = () => Math.floor(rand() * 200 - 100) / 10; // [-10, 10] con decimales

const N = 5000;
for (let i = 0; i < N; i++) {
  const nv = Math.floor(rand() * 6);
  const vec = [];
  const used = new Set();
  for (let j = 0; j < nv; j++) {
    const id = IDS[Math.floor(rand() * IDS.length)];
    if (used.has(id)) continue; // vecResults con ids únicos (como en uso real)
    used.add(id);
    vec.push(V(id, rscore(), { k: id }));
  }
  const nb = Math.floor(rand() * 6);
  const bm = [];
  const bused = new Set();
  for (let j = 0; j < nb; j++) {
    const id = IDS[Math.floor(rand() * IDS.length)];
    if (bused.has(id)) continue;
    bused.add(id);
    bm.push([id, rscore()]);
  }
  const limit = 1 + Math.floor(rand() * 6);
  const vw = Math.floor(rand() * 11) / 10;
  const tw = Math.floor(rand() * 11) / 10;
  check(vec, M(bm), limit, vw, tw, `rand#${i}`);
}

console.log(`OK: _fuseWeighted == oráculo en ${pass} casos (8 fijos + ${N} aleatorios)`);
