"use strict";
/**
 * benchmark-offline.js — micro-benchmark DETERMINISTA sin embeddings ni red.
 *
 * Mide latencia de consulta de los caminos calientes (search exhaustivo, binario, IVF y filtrado)
 * a varios tamaños de colección, con vectores sintéticos. Sirve para tener un baseline ANTES de
 * optimizar (p. ej. la lista invertida de IVF) y comparar después. No es un test de correctitud.
 *
 *   node benchmark-offline.js            # tamaños por defecto
 *   node benchmark-offline.js 1000 8000  # tamaños custom
 */
const {
  VectorStore, BinaryQuantizedStore, IVFIndex, MemoryStorageAdapter,
} = require("./js-vector-store.js");

const DIM = 256;
const QUERIES = 200;
const WARMUP = 20;
const SIZES = process.argv.slice(2).map(Number).filter((x) => x > 0);
const sizes = SIZES.length ? SIZES : [1000, 5000, 20000];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function vec(seed) {
  const g = rng(seed * 2654435761);
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = g() * 2 - 1;
  return v;
}

// Cronometra `fn(query)` sobre QUERIES consultas; devuelve {median, mean, qps} en ms.
function timeQueries(fn, querySeedBase) {
  for (let i = 0; i < WARMUP; i++) fn(vec(querySeedBase + i));
  const times = [];
  for (let i = 0; i < QUERIES; i++) {
    const q = vec(querySeedBase + 1000 + i);
    const t0 = process.hrtime.bigint();
    fn(q);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const median = times[times.length >> 1];
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  return { median, mean, qps: 1000 / mean };
}

function fill(store, n) {
  const g = rng(7);
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(DIM);
    for (let d = 0; d < DIM; d++) v[d] = g() * 2 - 1;
    store.set("c", "id" + i, v, { g: i % 5, label: "doc-" + (i % 100) });
  }
  store.flush("c");
}

const fmt = (x) => x.toFixed(4).padStart(9);
const row = (name, r) => console.log(`  ${name.padEnd(34)} ${fmt(r.median)} ms  ${fmt(r.mean)} ms  ${Math.round(r.qps).toString().padStart(8)} q/s`);

console.log(`js-vector-store — benchmark offline (dim=${DIM}, ${QUERIES} queries, limit=10)\n`);
console.log(`  ${"".padEnd(34)} ${"median".padStart(9)}     ${"mean".padStart(9)}     ${"throughput".padStart(8)}`);

for (const n of sizes) {
  console.log(`\nN = ${n} vectores`);

  const vs = new VectorStore(new MemoryStorageAdapter(), DIM);
  fill(vs, n);
  row("VectorStore.search (exhaustivo)", timeQueries((q) => vs.search("c", q, 10), 1));
  row("  + filtro $in (g in [0,1])", timeQueries((q) => vs.search("c", q, 10, 0, "cosine", { g: { $in: [0, 1] } }), 2));
  row("  + filtro $regex (label ^doc-1)", timeQueries((q) => vs.search("c", q, 10, 0, "cosine", { label: { $regex: "^doc-1" } }), 3));

  const bq = new BinaryQuantizedStore(new MemoryStorageAdapter(), DIM);
  fill(bq, n);
  row("BinaryQuantizedStore.search (1-bit)", timeQueries((q) => bq.search("c", q, 10), 4));

  const k = Math.max(2, Math.round(Math.sqrt(n)));
  const ivf = new IVFIndex(vs, k, Math.max(1, Math.round(k / 8)));
  const t0 = process.hrtime.bigint();
  ivf.build("c");
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const ivfRes = timeQueries((q) => ivf.search("c", q, 10), 5);
  row(`IVFIndex.search (k=${k}, probes=${ivf.numProbes})`, ivfRes);
  console.log(`    (IVF build: ${buildMs.toFixed(1)} ms)`);
}

console.log("\nNota: medianas en ms por consulta. IVF cercano al exhaustivo a N grande revela el");
console.log("barrido O(n) de _getCandidates (candidato a optimización: listas invertidas por cluster).");
