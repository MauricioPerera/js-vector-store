"use strict";
// Property-test CONGELADO de _kmeans (#17, la función más sensible: RNG + iteración de Lloyd).
// Oráculo INDEPENDIENTE: copia EXACTA del _kmeans original. El refactor solo extrae helpers
// (_nearestCentroid/_assignStep/_updateCentroids) sin cambiar el orden de operaciones ni el
// consumo de Math.random (que ocurre solo en _kmeansInit, al inicio). Con la MISMA semilla,
// refactor y oráculo deben dar {centroids, assignments} idénticos. 300 casos + bordes.

const assert = require("assert");
const { IVFIndex } = require("../../js-vector-store.js");

const idx = Object.create(IVFIndex.prototype); // `this` con los métodos del prototipo

function euclideanDistSq(a, aOff, b, bOff, dim) {
  let s = 0;
  for (let d = 0; d < dim; d++) { const x = a[aOff + d] - b[bOff + d]; s += x * x; }
  return s;
}

// Oráculo: _kmeans ORIGINAL (inline), usando el MISMO _kmeansInit (mismo consumo de RNG).
function kmeansOracle(flat, n, dim, k, maxIter = 20) {
  const actualK = Math.min(k, n);
  let centroids = idx._kmeansInit(flat, n, dim, actualK);
  const assignments = new Int32Array(n);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let bestC = 0, bestD = Infinity;
      for (let c = 0; c < actualK; c++) {
        const d = euclideanDistSq(flat, i * dim, centroids, c * dim, dim);
        if (d < bestD) { bestD = d; bestC = c; }
      }
      if (assignments[i] !== bestC) { assignments[i] = bestC; changed = true; }
    }
    if (!changed) break;
    const sums = new Float64Array(actualK * dim);
    const counts = new Int32Array(actualK);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      const iOff = i * dim, cOff = c * dim;
      for (let d = 0; d < dim; d++) sums[cOff + d] += flat[iOff + d];
    }
    for (let c = 0; c < actualK; c++) {
      if (counts[c] > 0) {
        const cOff = c * dim;
        for (let d = 0; d < dim; d++) centroids[cOff + d] = sums[cOff + d] / counts[c];
      }
    }
  }
  const centroidArrays = [];
  for (let c = 0; c < actualK; c++) centroidArrays.push(Array.from(centroids.subarray(c * dim, (c + 1) * dim)));
  return { centroids: centroidArrays, assignments: Array.from(assignments) };
}

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let pass = 0;
function check(flat, n, dim, k, seed, label) {
  const realRandom = Math.random;
  try {
    Math.random = rng(seed);
    const got = idx._kmeans(flat, n, dim, k);
    Math.random = rng(seed);
    const exp = kmeansOracle(flat, n, dim, k);
    assert.strictEqual(JSON.stringify(got), JSON.stringify(exp), label);
    pass++;
  } finally {
    Math.random = realRandom;
  }
}

function makeFlat(n, dim, seed) {
  const gen = rng(seed * 31 + 7);
  const flat = new Float64Array(n * dim);
  // puntos agrupados en clusters para que Lloyd itere de verdad
  for (let i = 0; i < n; i++) {
    const cluster = i % 3;
    for (let d = 0; d < dim; d++) flat[i * dim + d] = cluster * 10 + (gen() * 2 - 1);
  }
  return flat;
}

// --- Bordes ---------------------------------------------------------------------------------
check(makeFlat(1, 4, 1), 1, 4, 5, 100, "n=1 (actualK=1)");
check(makeFlat(3, 2, 2), 3, 2, 5, 101, "k>n (actualK=n)");
check(makeFlat(20, 8, 3), 20, 8, 1, 102, "k=1 (un cluster)");
check(makeFlat(2, 2, 4), 2, 2, 2, 103, "n=k=2");

// --- Aleatorio con semilla fija --------------------------------------------------------------
const N = 300;
for (let t = 0; t < N; t++) {
  const dim = 2 + (t % 6);
  const n = 5 + (t % 25);
  const k = 2 + (t % 5);
  check(makeFlat(n, dim, t + 1), n, dim, k, 5000 + t, `rand#${t} (n=${n},dim=${dim},k=${k})`);
}

console.log(`OK: _kmeans == oráculo en ${pass} casos (4 bordes + ${N} aleatorios)`);
