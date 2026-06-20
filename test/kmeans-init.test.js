"use strict";
// Equivalencia del _kmeansInit optimizado (dists incremental, O(n·k·dim)) vs el ORIGINAL
// (recomputaba O(n·k²·dim)). Mismo consumo de Math.random -> centroides idénticos byte a byte.
//   node --test test/kmeans-init.test.js
const { test } = require("node:test");
const assert = require("node:assert");
const { IVFIndex } = require("../js-vector-store.js");

function eds(a, ao, b, bo, dim) {
  let s = 0;
  for (let d = 0; d < dim; d++) { const x = a[ao + d] - b[bo + d]; s += x * x; }
  return s;
}

// Oráculo: k-means++ init ORIGINAL (recomputa la distancia a todos los centroides en cada paso).
function originalInit(flat, n, dim, k) {
  const C = new Float64Array(k * dim);
  const first = Math.floor(Math.random() * n);
  for (let d = 0; d < dim; d++) C[d] = flat[first * dim + d];
  const dists = new Float64Array(n);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      for (let cc = 0; cc < c; cc++) { const dd = eds(flat, i * dim, C, cc * dim, dim); if (dd < m) m = dd; }
      dists[i] = m; total += m;
    }
    let r = Math.random() * total, chosen = 0;
    for (let i = 0; i < n; i++) { r -= dists[i]; if (r <= 0) { chosen = i; break; } }
    for (let d = 0; d < dim; d++) C[c * dim + d] = flat[chosen * dim + d];
  }
  return C;
}

function seeded(s) {
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("_kmeansInit incremental == original (200 casos, RNG seedeado)", () => {
  const idx = Object.create(IVFIndex.prototype);
  const real = Math.random;
  try {
    for (let t = 0; t < 200; t++) {
      const dim = 2 + (t % 5), n = 10 + (t % 20), k = 2 + (t % 6);
      const g = seeded(1000 + t);
      const flat = new Float64Array(n * dim);
      for (let i = 0; i < flat.length; i++) flat[i] = Math.floor(g() * 100);
      Math.random = seeded(7000 + t);
      const got = idx._kmeansInit(flat, n, dim, k);
      Math.random = seeded(7000 + t);
      const exp = originalInit(flat, n, dim, k);
      assert.deepStrictEqual(Array.from(got), Array.from(exp), `caso ${t}`);
    }
  } finally {
    Math.random = real;
  }
});
