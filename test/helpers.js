"use strict";
// Utilidades compartidas de la batería: vectores sintéticos DETERMINISTAS (sin embeddings/red).

const path = require("path");
const lib = require("../js-vector-store.js");

// PRNG determinista (mulberry32).
function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Vector determinista por semilla, en [-1, 1].
function vec(seed, dim = 8) {
  const g = rng(seed * 2654435761);
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = g() * 2 - 1;
  return v;
}

// Inserta n vectores en `store` (col "c") y los devuelve. metadata: {g: i%3, even: i%2===0}.
function populate(store, n, dim = 8, baseSeed = 100) {
  const vecs = [];
  for (let i = 0; i < n; i++) {
    const v = vec(baseSeed + i, dim);
    vecs.push(v);
    store.set("c", "id" + i, v, { g: i % 3, even: i % 2 === 0 });
  }
  store.flush("c");
  return vecs;
}

const ids = (results) => results.map((r) => r.id);

module.exports = { lib, rng, vec, populate, ids, path };
