// Construye un índice binario OFFLINE y lo escribe como index.jvs (bundle para subir a R2).
// En tu app, reemplazá los vectores sintéticos por tus embeddings reales.
//   node build-index.js
import pkg from "../../js-vector-store.js";
import { writeFileSync } from "node:fs";
const { BinaryQuantizedStore, MemoryStorageAdapter } = pkg;

const DIM = 256;
const N = 2000;

function rng(s) {
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const adapter = new MemoryStorageAdapter();
const store = new BinaryQuantizedStore(adapter, DIM);
const g = rng(1);
for (let i = 0; i < N; i++) {
  const v = new Float32Array(DIM);
  for (let d = 0; d < DIM; d++) v[d] = g() * 2 - 1;     // <-- acá iría tu embedding real
  store.set("docs", "id" + i, v, { group: i % 10 });
}
store.flush("docs");

const bundle = adapter.toBundle();
writeFileSync("index.jvs", Buffer.from(bundle));
console.log(`index.jvs escrito: ${N} vectores (dim ${DIM}), ${(bundle.byteLength / 1024).toFixed(1)} KB.`);
console.log("Subir a R2:  wrangler r2 object put jvs-index/index.jvs --file index.jvs");
