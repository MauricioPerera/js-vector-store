/**
 * js-vector-store
 * Port vanilla JS de php-vector-store (MauricioPerera)
 * Zero dependencias — funciona en Node.js y browser (con adaptador de storage)
 *
 * Backends:
 *   VectorStore          → Float32, dim×4 bytes/vector
 *   QuantizedStore       → Int8, dim+8 bytes/vector (~4x más compacto)
 *   BinaryQuantizedStore → 1-bit, ceil(dim/8) bytes/vector (~32x más compacto)
 *   IVFIndex             → K-means clustering encima de cualquiera de los tres
 *
 * API idéntica a la versión PHP.
 */

// ---------------------------------------------------------------------------
// MIN-HEAP (top-K por score, tamaño acotado)
// ---------------------------------------------------------------------------

class TopKHeap {
  constructor(k) {
    this.k    = k;
    this.data = [];
  }

  push(item) {
    if (this.data.length < this.k) {
      this.data.push(item);
      this._bubbleUp(this.data.length - 1);
    } else if (item.score > this.data[0].score) {
      this.data[0] = item;
      this._sinkDown(0);
    }
  }

  sorted() {
    const out = this.data.slice();
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].score < this.data[parent].score) {
        const tmp = this.data[i]; this.data[i] = this.data[parent]; this.data[parent] = tmp;
        i = parent;
      } else break;
    }
  }

  _sinkDown(i) {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.data[l].score < this.data[smallest].score) smallest = l;
      if (r < n && this.data[r].score < this.data[smallest].score) smallest = r;
      if (smallest !== i) {
        const tmp = this.data[i]; this.data[i] = this.data[smallest]; this.data[smallest] = tmp;
        i = smallest;
      } else break;
    }
  }
}

// ---------------------------------------------------------------------------
// POPCOUNT LOOKUP TABLE (para BinaryQuantizedStore)
// ---------------------------------------------------------------------------

const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let n = i, c = 0;
  while (n) { c++; n &= n - 1; }
  POPCOUNT[i] = c;
}

// ---------------------------------------------------------------------------
// MATH UTILS
// ---------------------------------------------------------------------------

/**
 * Normaliza un vector a longitud 1 (L2).
 * @param {number[]|Float32Array} v
 * @returns {number[]}
 */
function normalize(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return Array.from(v);
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * Similitud coseno entre a y b, usando solo los primeros `dims` elementos.
 * Funciona con number[], Float32Array, Float64Array, o cualquier indexable.
 */
function cosineSim(a, b, dims) {
  const n = dims ?? Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i], bi = b[i];
    dot += ai * bi;
    na  += ai * ai;
    nb  += bi * bi;
  }
  const denom = Math.sqrt(na * nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Distancia euclidiana entre a y b.
 */
function euclideanDist(a, b, dims) {
  const n = dims ?? Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
}

/**
 * Distancia euclidiana al cuadrado (evita sqrt para comparaciones).
 */
function euclideanDistSq(a, aOff, b, bOff, dims) {
  let sum = 0;
  for (let i = 0; i < dims; i++) { const d = a[aOff + i] - b[bOff + i]; sum += d * d; }
  return sum;
}

/**
 * Producto punto entre a y b.
 */
function dotProduct(a, b, dims) {
  const n = dims ?? Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Distancia Manhattan (L1) entre a y b.
 */
function manhattanDist(a, b, dims) {
  const n = dims ?? Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
}

/**
 * Calcula score entre dos vectores usando la métrica indicada.
 * Retorna un valor donde mayor = más similar.
 * @param {number[]|Float32Array} a
 * @param {number[]|Float32Array} b
 * @param {number} dims
 * @param {'cosine'|'euclidean'|'dotProduct'|'manhattan'} metric
 * @returns {number}
 */
function computeScore(a, b, dims, metric) {
  switch (metric) {
    case 'cosine':     return cosineSim(a, b, dims);
    case 'dotProduct': return dotProduct(a, b, dims);
    case 'euclidean':  return 1 / (1 + euclideanDist(a, b, dims));
    case 'manhattan':  return 1 / (1 + manhattanDist(a, b, dims));
    default:           return cosineSim(a, b, dims);
  }
}

// ---------------------------------------------------------------------------
// SEARCH ACROSS WITH SCORE NORMALIZATION
// ---------------------------------------------------------------------------

/**
 * Normaliza scores por colección a [0,1] y mergea con heap.
 * Usado por searchAcross en todos los stores.
 */
function _normalizedSearchAcross(store, collections, query, limit, metric) {
  if (collections.length <= 1) {
    // Sin normalización para colección única
    const col = collections[0];
    return store.search(col, query, limit, 0, metric);
  }

  const perCol = [];
  for (const col of collections) {
    const results = store.search(col, query, limit, 0, metric);
    if (results.length > 0) perCol.push(results);
  }

  const heap = new TopKHeap(limit);
  for (const results of perCol) {
    let min = Infinity, max = -Infinity;
    for (const r of results) {
      if (r.score < min) min = r.score;
      if (r.score > max) max = r.score;
    }
    const range = max - min;
    for (const r of results) {
      const normalized = range > 0 ? (r.score - min) / range : 1.0;
      heap.push({ ...r, score: normalized });
    }
  }
  return heap.sorted();
}

// ---------------------------------------------------------------------------
// STORAGE ADAPTERS
// ---------------------------------------------------------------------------

let _fs = null;
let _path = null;

function _getFs() {
  if (!_fs) {
    try {
      _fs   = require('fs');
      _path = require('path');
    } catch {
      throw new Error('VectorStore: entorno sin fs — usá un StorageAdapter personalizado');
    }
  }
  return { fs: _fs, path: _path };
}

class FileStorageAdapter {
  constructor(dir) {
    const { fs, path } = _getFs();
    this.dir  = dir;
    this.fs   = fs;
    this.path = path;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  readBin(filename) {
    const file = this.path.join(this.dir, filename);
    if (!this.fs.existsSync(file)) return null;
    const buf = this.fs.readFileSync(file);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  writeBin(filename, buffer) {
    const file = this.path.join(this.dir, filename);
    this.fs.writeFileSync(file, Buffer.from(buffer));
  }

  readJson(filename) {
    const file = this.path.join(this.dir, filename);
    if (!this.fs.existsSync(file)) return null;
    return JSON.parse(this.fs.readFileSync(file, 'utf8'));
  }

  writeJson(filename, data) {
    const file = this.path.join(this.dir, filename);
    this.fs.writeFileSync(file, JSON.stringify(data));
  }

  delete(filename) {
    const file = this.path.join(this.dir, filename);
    if (this.fs.existsSync(file)) this.fs.unlinkSync(file);
  }
}

class MemoryStorageAdapter {
  constructor() {
    this._bins  = new Map();
    this._jsons = new Map();
  }
  readBin(k)       { return this._bins.get(k) ?? null; }
  writeBin(k, v)   { this._bins.set(k, v); }
  readJson(k)      { return this._jsons.get(k) ?? null; }
  writeJson(k, v)  { this._jsons.set(k, v); }
  delete(k)        { this._bins.delete(k); this._jsons.delete(k); }
}

// ---------------------------------------------------------------------------
// VECTOR STORE (Float32) — OPTIMIZED
// ---------------------------------------------------------------------------

class VectorStore {
  constructor(dirOrAdapter, dim = 768, maxCollections = 50) {
    this.dim           = dim;
    this.maxCollections = maxCollections;
    this._adapter      = typeof dirOrAdapter === 'string'
      ? new FileStorageAdapter(dirOrAdapter)
      : dirOrAdapter;
    this._collections = new Map();
    this._stride = dim * 4;
  }

  _binFile(col)  { return `${col}.bin`; }
  _jsonFile(col) { return `${col}.json`; }

  _load(col) {
    if (this._collections.has(col)) return this._collections.get(col);
    const manifest = this._adapter.readJson(this._jsonFile(col));
    const ids  = manifest ? manifest.ids  : [];
    const meta = manifest ? manifest.meta : [];
    const idMap = new Map();
    for (let i = 0; i < ids.length; i++) idMap.set(ids[i], i);
    const bin = this._adapter.readBin(this._binFile(col));
    const entry = { ids, meta, idMap, bin, pending: [], dirty: false };
    this._collections.set(col, entry);
    return entry;
  }

  _readVec(col, idx) {
    const entry = this._collections.get(col) || this._load(col);
    const committed = entry.idMap.size - entry.pending.length;
    if (idx < committed) {
      if (!entry.bin) return null;
      return new Float32Array(entry.bin, idx * this._stride, this.dim);
    }
    return entry.pending[idx - committed].vector;
  }

  _rebuildBin(entry) {
    const committed = entry.ids.length - entry.pending.length;
    const totalVecs = entry.ids.length;
    const buf = new ArrayBuffer(totalVecs * this._stride);
    const f32 = new Float32Array(buf);
    if (entry.bin && committed > 0) {
      f32.set(new Float32Array(entry.bin, 0, committed * this.dim));
    }
    for (let p = 0; p < entry.pending.length; p++) {
      const vec = entry.pending[p].vector;
      const offset = (committed + p) * this.dim;
      for (let d = 0; d < this.dim; d++) f32[offset + d] = vec[d] ?? 0;
    }
    return buf;
  }

  set(col, id, vector, metadata = {}) {
    const entry    = this._load(col);
    const existing = entry.idMap.get(id);
    if (existing !== undefined) {
      const committed = entry.ids.length - entry.pending.length;
      if (existing < committed) {
        if (entry.bin) {
          const f32 = new Float32Array(entry.bin, existing * this._stride, this.dim);
          for (let d = 0; d < this.dim; d++) f32[d] = vector[d] ?? 0;
        }
      } else {
        entry.pending[existing - committed].vector = vector;
      }
      entry.meta[existing] = metadata;
    } else {
      const idx = entry.ids.length;
      entry.ids.push(id);
      entry.meta.push(metadata);
      entry.idMap.set(id, idx);
      entry.pending.push({ id, vector, metadata });
    }
    entry.dirty = true;
  }

  remove(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return false;
    if (entry.pending.length > 0) this._flushCol(col, entry);
    const totalVecs = entry.ids.length;
    const newBuf = new ArrayBuffer((totalVecs - 1) * this._stride);
    const dst = new Float32Array(newBuf);
    let writeIdx = 0;
    for (let i = 0; i < totalVecs; i++) {
      if (i === idx) continue;
      dst.set(new Float32Array(entry.bin, i * this._stride, this.dim), writeIdx * this.dim);
      writeIdx++;
    }
    entry.ids.splice(idx, 1);
    entry.meta.splice(idx, 1);
    entry.idMap.clear();
    for (let i = 0; i < entry.ids.length; i++) entry.idMap.set(entry.ids[i], i);
    entry.bin = newBuf;
    this._adapter.writeBin(this._binFile(col), newBuf);
    entry.dirty = true;
    return true;
  }

  drop(col) {
    this._adapter.delete(this._binFile(col));
    this._adapter.delete(this._jsonFile(col));
    this._collections.delete(col);
  }

  _flushCol(col, entry) {
    if (entry.pending.length > 0) {
      entry.bin = this._rebuildBin(entry);
      entry.pending = [];
    }
    if (entry.bin) this._adapter.writeBin(this._binFile(col), entry.bin);
    this._adapter.writeJson(this._jsonFile(col), { ids: entry.ids, meta: entry.meta, dim: this.dim });
    entry.dirty = false;
  }

  flush() {
    for (const [col, entry] of this._collections) {
      if (entry.dirty) this._flushCol(col, entry);
    }
  }

  get(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return null;
    return { id, vector: Array.from(this._readVec(col, idx)), metadata: entry.meta[idx] };
  }

  has(col, id)       { return this._load(col).idMap.has(id); }
  count(col)         { return this._load(col).ids.length; }
  ids(col)           { return this._load(col).ids.slice(); }
  collections()      { return Array.from(this._collections.keys()); }

  stats() {
    const result = {};
    for (const col of this._collections.keys()) {
      result[col] = { count: this.count(col), dim: this.dim };
    }
    return result;
  }

  import(col, records) {
    for (const r of records) this.set(col, r.id, r.vector, r.metadata ?? {});
    return records.length;
  }

  export(col) {
    const entry = this._load(col);
    return entry.ids.map((id, i) => ({
      id, vector: Array.from(this._readVec(col, i)), metadata: entry.meta[i],
    }));
  }

  search(col, query, limit = 5, dimSlice = 0, metric = 'cosine') {
    const entry = this._load(col);
    const dims  = dimSlice > 0 ? dimSlice : this.dim;
    const n     = entry.ids.length;
    const heap  = new TopKHeap(limit);
    for (let i = 0; i < n; i++) {
      const vec   = this._readVec(col, i);
      const score = computeScore(query, vec, dims, metric);
      heap.push({ id: entry.ids[i], score, metadata: entry.meta[i] });
    }
    return heap.sorted();
  }

  matryoshkaSearch(col, query, limit = 5, stages = [128, 384, 768], metric = 'cosine') {
    const entry = this._load(col);
    if (entry.ids.length === 0) return [];
    const factor = 4;
    let candidates = entry.ids.map((id, i) => ({ id, idx: i, metadata: entry.meta[i] }));
    for (let s = 0; s < stages.length; s++) {
      const dims  = Math.min(stages[s], this.dim);
      const keepN = s < stages.length - 1
        ? Math.max(limit * factor * (stages.length - s), limit) : limit;
      const heap = new TopKHeap(keepN);
      for (const c of candidates) {
        const vec   = this._readVec(col, c.idx);
        const score = computeScore(query, vec, dims, metric);
        heap.push({ ...c, score });
      }
      candidates = heap.sorted();
    }
    return candidates.slice(0, limit).map(({ id, score, metadata }) => ({ id, score, metadata }));
  }

  searchAcross(collections, query, limit = 5, metric = 'cosine') {
    return _normalizedSearchAcross(this, collections, query, limit, metric);
  }

  static normalize      = normalize;
  static cosineSim      = cosineSim;
  static euclideanDist  = euclideanDist;
  static dotProduct     = dotProduct;
  static manhattanDist  = manhattanDist;
  static computeScore   = computeScore;
}

// ---------------------------------------------------------------------------
// QUANTIZED STORE (Int8) — OPTIMIZED
// ---------------------------------------------------------------------------

class QuantizedStore {
  constructor(dirOrAdapter, dim = 768) {
    this.dim      = dim;
    this._adapter = typeof dirOrAdapter === 'string'
      ? new FileStorageAdapter(dirOrAdapter)
      : dirOrAdapter;
    this._collections = new Map();
  }

  _binFile(col)  { return `${col}.q8.bin`; }
  _jsonFile(col) { return `${col}.q8.json`; }
  get _stride() { return 8 + this.dim; }

  _load(col) {
    if (this._collections.has(col)) return this._collections.get(col);
    const manifest = this._adapter.readJson(this._jsonFile(col));
    const ids  = manifest ? manifest.ids  : [];
    const meta = manifest ? manifest.meta : [];
    const idMap = new Map();
    for (let i = 0; i < ids.length; i++) idMap.set(ids[i], i);
    const bin = this._adapter.readBin(this._binFile(col));
    const entry = { ids, meta, idMap, bin, pending: [], dirty: false };
    this._collections.set(col, entry);
    return entry;
  }

  _quantize(vector) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < vector.length; i++) {
      const x = vector[i];
      if (x < min) min = x;
      if (x > max) max = x;
    }
    const range = max - min || 1;
    const int8  = new Int8Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      int8[i] = Math.round(((vector[i] - min) / range) * 255) - 128;
    }
    return { int8, min, max };
  }

  _dequantize(int8, min, max) {
    const range  = max - min || 1;
    const result = new Float64Array(int8.length);
    for (let i = 0; i < int8.length; i++) {
      result[i] = ((int8[i] + 128) / 255) * range + min;
    }
    return result;
  }

  _readVec(col, idx) {
    const entry = this._collections.get(col) || this._load(col);
    const committed = entry.ids.length - entry.pending.length;
    if (idx < committed) {
      if (!entry.bin) return null;
      const offset = idx * this._stride;
      const view   = new DataView(entry.bin);
      const min    = view.getFloat32(offset, true);
      const max    = view.getFloat32(offset + 4, true);
      const int8   = new Int8Array(entry.bin, offset + 8, this.dim);
      return this._dequantize(int8, min, max);
    }
    const p = entry.pending[idx - committed];
    const view = new DataView(p.packed);
    const min  = view.getFloat32(0, true);
    const max  = view.getFloat32(4, true);
    const int8 = new Int8Array(p.packed, 8, this.dim);
    return this._dequantize(int8, min, max);
  }

  _packVec(vector) {
    const { int8, min, max } = this._quantize(vector);
    const buf  = new ArrayBuffer(this._stride);
    const view = new DataView(buf);
    view.setFloat32(0, min, true);
    view.setFloat32(4, max, true);
    new Int8Array(buf, 8).set(int8);
    return buf;
  }

  set(col, id, vector, metadata = {}) {
    const entry    = this._load(col);
    const existing = entry.idMap.get(id);
    const packed   = this._packVec(vector);
    if (existing !== undefined) {
      const committed = entry.ids.length - entry.pending.length;
      if (existing < committed) {
        if (entry.bin) new Uint8Array(entry.bin).set(new Uint8Array(packed), existing * this._stride);
      } else {
        entry.pending[existing - committed].packed = packed;
      }
      entry.meta[existing] = metadata;
    } else {
      const idx = entry.ids.length;
      entry.ids.push(id);
      entry.meta.push(metadata);
      entry.idMap.set(id, idx);
      entry.pending.push({ id, packed, metadata });
    }
    entry.dirty = true;
  }

  remove(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return false;
    if (entry.pending.length > 0) this._flushCol(col, entry);
    const totalVecs = entry.ids.length;
    const stride = this._stride;
    const newBuf = new ArrayBuffer((totalVecs - 1) * stride);
    const dst = new Uint8Array(newBuf);
    const src = new Uint8Array(entry.bin);
    let writeIdx = 0;
    for (let i = 0; i < totalVecs; i++) {
      if (i === idx) continue;
      dst.set(src.subarray(i * stride, (i + 1) * stride), writeIdx * stride);
      writeIdx++;
    }
    entry.ids.splice(idx, 1);
    entry.meta.splice(idx, 1);
    entry.idMap.clear();
    for (let i = 0; i < entry.ids.length; i++) entry.idMap.set(entry.ids[i], i);
    entry.bin = newBuf;
    this._adapter.writeBin(this._binFile(col), newBuf);
    entry.dirty = true;
    return true;
  }

  drop(col) {
    this._adapter.delete(this._binFile(col));
    this._adapter.delete(this._jsonFile(col));
    this._collections.delete(col);
  }

  _flushCol(col, entry) {
    if (entry.pending.length > 0) {
      const committed = entry.ids.length - entry.pending.length;
      const total = entry.ids.length;
      const stride = this._stride;
      const newBuf = new ArrayBuffer(total * stride);
      const dst = new Uint8Array(newBuf);
      if (entry.bin && committed > 0) dst.set(new Uint8Array(entry.bin, 0, committed * stride));
      for (let p = 0; p < entry.pending.length; p++) {
        dst.set(new Uint8Array(entry.pending[p].packed), (committed + p) * stride);
      }
      entry.bin = newBuf;
      entry.pending = [];
    }
    if (entry.bin) this._adapter.writeBin(this._binFile(col), entry.bin);
    this._adapter.writeJson(this._jsonFile(col), { ids: entry.ids, meta: entry.meta, dim: this.dim });
    entry.dirty = false;
  }

  flush() {
    for (const [col, entry] of this._collections) {
      if (entry.dirty) this._flushCol(col, entry);
    }
  }

  get(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return null;
    return { id, vector: Array.from(this._readVec(col, idx)), metadata: entry.meta[idx] };
  }

  has(col, id)  { return this._load(col).idMap.has(id); }
  count(col)    { return this._load(col).ids.length; }
  ids(col)      { return this._load(col).ids.slice(); }

  search(col, query, limit = 5, dimSlice = 0, metric = 'cosine') {
    const entry = this._load(col);
    if (entry.pending.length > 0) this._flushCol(col, entry);
    const dims = dimSlice > 0 ? dimSlice : this.dim;
    const n    = entry.ids.length;
    const heap = new TopKHeap(limit);
    for (let i = 0; i < n; i++) {
      const vec   = this._readVec(col, i);
      const score = computeScore(query, vec, dims, metric);
      heap.push({ id: entry.ids[i], score, metadata: entry.meta[i] });
    }
    return heap.sorted();
  }

  matryoshkaSearch(col, query, limit = 5, stages = [128, 256, 384], metric = 'cosine') {
    const entry = this._load(col);
    if (entry.ids.length === 0) return [];
    if (entry.pending.length > 0) this._flushCol(col, entry);
    const factor = 4;
    let candidates = entry.ids.map((id, i) => ({ id, idx: i, metadata: entry.meta[i] }));
    for (let s = 0; s < stages.length; s++) {
      const dims  = Math.min(stages[s], this.dim);
      const keepN = s < stages.length - 1
        ? Math.max(limit * factor * (stages.length - s), limit) : limit;
      const heap = new TopKHeap(keepN);
      for (const c of candidates) {
        const vec   = this._readVec(col, c.idx);
        const score = computeScore(query, vec, dims, metric);
        heap.push({ ...c, score });
      }
      candidates = heap.sorted();
    }
    return candidates.slice(0, limit).map(({ id, score, metadata }) => ({ id, score, metadata }));
  }

  searchAcross(collections, query, limit = 5, metric = 'cosine') {
    return _normalizedSearchAcross(this, collections, query, limit, metric);
  }

  import(col, records) {
    for (const r of records) this.set(col, r.id, r.vector, r.metadata ?? {});
    return records.length;
  }

  export(col) {
    const entry = this._load(col);
    return entry.ids.map((id, i) => ({
      id, vector: Array.from(this._readVec(col, i)), metadata: entry.meta[i],
    }));
  }
}

// ---------------------------------------------------------------------------
// BINARY QUANTIZED STORE (1-bit) — 32x compression
// ---------------------------------------------------------------------------
// Cada float se reduce a su bit de signo: >= 0 → 1, < 0 → 0
// Empaquetado MSB-first: dim 0 es el bit alto del byte 0
// Similitud via Hamming: cosine_approx = 1.0 - 2.0 * hamming / dims

class BinaryQuantizedStore {
  constructor(dirOrAdapter, dim = 768) {
    this.dim      = dim;
    this._bpv     = Math.ceil(dim / 8); // bytes per vector
    this._adapter = typeof dirOrAdapter === 'string'
      ? new FileStorageAdapter(dirOrAdapter)
      : dirOrAdapter;
    this._collections = new Map();
  }

  _binFile(col)  { return `${col}.b1.bin`; }
  _jsonFile(col) { return `${col}.b1.json`; }

  _load(col) {
    if (this._collections.has(col)) return this._collections.get(col);
    const manifest = this._adapter.readJson(this._jsonFile(col));
    const ids  = manifest ? manifest.ids  : [];
    const meta = manifest ? manifest.meta : [];
    const idMap = new Map();
    for (let i = 0; i < ids.length; i++) idMap.set(ids[i], i);
    const bin = this._adapter.readBin(this._binFile(col));
    const entry = { ids, meta, idMap, bin, pending: [], dirty: false };
    this._collections.set(col, entry);
    return entry;
  }

  /**
   * Cuantiza float[] a binario (1-bit por dimensión).
   * Normaliza primero, luego sign-bit MSB-first.
   * @returns {Uint8Array}
   */
  static quantize(vector, dim) {
    const norm = normalize(vector);
    const bytes = new Uint8Array(Math.ceil(dim / 8));
    const d = Math.min(norm.length, dim);
    for (let i = 0; i < d; i++) {
      if (norm[i] >= 0) {
        bytes[i >> 3] |= (1 << (7 - (i & 7)));
      }
    }
    return bytes;
  }

  /**
   * Dequantiza binario a float[]: bit 1 → +1.0, bit 0 → -1.0
   */
  static dequantize(buf, offset, dim) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const floats = new Array(dim);
    for (let i = 0; i < dim; i++) {
      const bit = (u8[offset + (i >> 3)] >> (7 - (i & 7))) & 1;
      floats[i] = bit ? 1.0 : -1.0;
    }
    return floats;
  }

  /**
   * Coseno aproximado via Hamming: 1.0 - 2.0 * hamming / dims
   */
  static binaryCosineSim(a, aOff, b, bOff, dims) {
    const bytesToCmp = Math.ceil(dims / 8);
    let hamming = 0;
    for (let i = 0; i < bytesToCmp; i++) {
      hamming += POPCOUNT[a[aOff + i] ^ b[bOff + i]];
    }
    // Correccion si dims no es multiplo de 8
    const remainder = dims & 7;
    if (remainder > 0) {
      const last = bytesToCmp - 1;
      const xor  = a[aOff + last] ^ b[bOff + last];
      const mask = (0xFF << (8 - remainder)) & 0xFF;
      hamming = hamming - POPCOUNT[xor] + POPCOUNT[xor & mask];
    }
    return 1.0 - (2.0 * hamming / dims);
  }

  /** Lee el binario de un vector desde buffer cacheado o pending. */
  _readBin(col, idx) {
    const entry = this._collections.get(col) || this._load(col);
    const committed = entry.ids.length - entry.pending.length;
    if (idx < committed) {
      if (!entry.bin) return null;
      return new Uint8Array(entry.bin, idx * this._bpv, this._bpv);
    }
    return entry.pending[idx - committed].packed;
  }

  /** Lee el vector dequantizado (+1/-1). */
  _readVec(col, idx) {
    const entry = this._collections.get(col) || this._load(col);
    const committed = entry.ids.length - entry.pending.length;
    if (idx < committed) {
      if (!entry.bin) return null;
      return BinaryQuantizedStore.dequantize(entry.bin, idx * this._bpv, this.dim);
    }
    const packed = entry.pending[idx - committed].packed;
    return BinaryQuantizedStore.dequantize(packed, 0, this.dim);
  }

  set(col, id, vector, metadata = {}) {
    const entry    = this._load(col);
    const existing = entry.idMap.get(id);
    const packed   = BinaryQuantizedStore.quantize(vector, this.dim);

    if (existing !== undefined) {
      const committed = entry.ids.length - entry.pending.length;
      if (existing < committed) {
        if (entry.bin) {
          new Uint8Array(entry.bin).set(packed, existing * this._bpv);
        }
      } else {
        entry.pending[existing - committed].packed = packed;
      }
      entry.meta[existing] = metadata;
    } else {
      const idx = entry.ids.length;
      entry.ids.push(id);
      entry.meta.push(metadata);
      entry.idMap.set(id, idx);
      entry.pending.push({ id, packed, metadata });
    }
    entry.dirty = true;
  }

  /** Swap-with-last delete (como PHP). */
  remove(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return false;
    if (entry.pending.length > 0) this._flushCol(col, entry);

    const lastIdx = entry.ids.length - 1;
    const bpv = this._bpv;
    const u8 = new Uint8Array(entry.bin);

    if (idx !== lastIdx) {
      // Swap last into position of deleted
      const lastId = entry.ids[lastIdx];
      u8.copyWithin(idx * bpv, lastIdx * bpv, (lastIdx + 1) * bpv);
      entry.ids[idx]  = lastId;
      entry.meta[idx] = entry.meta[lastIdx];
      entry.idMap.set(lastId, idx);
    }

    entry.ids.pop();
    entry.meta.pop();
    entry.idMap.delete(id);

    // Truncate buffer
    entry.bin = entry.bin.slice(0, entry.ids.length * bpv);
    this._adapter.writeBin(this._binFile(col), entry.bin);
    entry.dirty = true;
    return true;
  }

  drop(col) {
    this._adapter.delete(this._binFile(col));
    this._adapter.delete(this._jsonFile(col));
    this._collections.delete(col);
  }

  _flushCol(col, entry) {
    if (entry.pending.length > 0) {
      const committed = entry.ids.length - entry.pending.length;
      const total = entry.ids.length;
      const bpv = this._bpv;
      const newBuf = new ArrayBuffer(total * bpv);
      const dst = new Uint8Array(newBuf);
      if (entry.bin && committed > 0) {
        dst.set(new Uint8Array(entry.bin, 0, committed * bpv));
      }
      for (let p = 0; p < entry.pending.length; p++) {
        dst.set(entry.pending[p].packed, (committed + p) * bpv);
      }
      entry.bin = newBuf;
      entry.pending = [];
    }
    if (entry.bin) this._adapter.writeBin(this._binFile(col), entry.bin);
    this._adapter.writeJson(this._jsonFile(col), { ids: entry.ids, meta: entry.meta, dim: this.dim });
    entry.dirty = false;
  }

  flush() {
    for (const [col, entry] of this._collections) {
      if (entry.dirty) this._flushCol(col, entry);
    }
  }

  get(col, id) {
    const entry = this._load(col);
    const idx   = entry.idMap.get(id);
    if (idx === undefined) return null;
    return { id, vector: this._readVec(col, idx), metadata: entry.meta[idx] };
  }

  has(col, id)  { return this._load(col).idMap.has(id); }
  count(col)    { return this._load(col).ids.length; }
  ids(col)      { return this._load(col).ids.slice(); }

  bytesPerVector() { return this._bpv; }

  /**
   * Search: cosine usa Hamming directo (ultra-rapido), otros dequantizan.
   */
  search(col, query, limit = 5, dimSlice = 0, metric = 'cosine') {
    const entry = this._load(col);
    if (entry.pending.length > 0) this._flushCol(col, entry);
    const dims = dimSlice > 0 ? Math.min(dimSlice, this.dim) : this.dim;
    const n    = entry.ids.length;
    const heap = new TopKHeap(limit);

    if (metric === 'cosine' && entry.bin) {
      const qBin = BinaryQuantizedStore.quantize(query, this.dim);
      const u8   = new Uint8Array(entry.bin);
      const bpv  = this._bpv;
      for (let i = 0; i < n; i++) {
        const score = BinaryQuantizedStore.binaryCosineSim(qBin, 0, u8, i * bpv, dims);
        heap.push({ id: entry.ids[i], score, metadata: entry.meta[i] });
      }
    } else {
      const qNorm = normalize(query);
      for (let i = 0; i < n; i++) {
        const vec   = this._readVec(col, i);
        const score = computeScore(qNorm, vec, dims, metric);
        heap.push({ id: entry.ids[i], score, metadata: entry.meta[i] });
      }
    }

    return heap.sorted();
  }

  matryoshkaSearch(col, query, limit = 5, stages = [128, 384, 768], metric = 'cosine') {
    const entry = this._load(col);
    if (entry.ids.length === 0) return [];
    if (entry.pending.length > 0) this._flushCol(col, entry);

    const factor = 4;
    const useBinary = metric === 'cosine' && entry.bin;
    const qBin  = useBinary ? BinaryQuantizedStore.quantize(query, this.dim) : null;
    const qNorm = useBinary ? null : normalize(query);
    const u8    = useBinary ? new Uint8Array(entry.bin) : null;
    const bpv   = this._bpv;

    let candidates = entry.ids.map((id, i) => ({ id, idx: i, metadata: entry.meta[i] }));

    for (let s = 0; s < stages.length; s++) {
      const dims  = Math.min(stages[s], this.dim);
      const keepN = s < stages.length - 1
        ? Math.max(limit * factor * (stages.length - s), limit) : limit;
      const heap = new TopKHeap(keepN);

      for (const c of candidates) {
        let score;
        if (useBinary) {
          score = BinaryQuantizedStore.binaryCosineSim(qBin, 0, u8, c.idx * bpv, dims);
        } else {
          const vec = this._readVec(col, c.idx);
          score = computeScore(qNorm, vec, dims, metric);
        }
        heap.push({ ...c, score });
      }
      candidates = heap.sorted();
    }

    return candidates.slice(0, limit).map(({ id, score, metadata }) => ({ id, score, metadata }));
  }

  searchAcross(collections, query, limit = 5, metric = 'cosine') {
    return _normalizedSearchAcross(this, collections, query, limit, metric);
  }

  import(col, records) {
    for (const r of records) this.set(col, r.id, r.vector, r.metadata ?? {});
    return records.length;
  }

  export(col) {
    const entry = this._load(col);
    return entry.ids.map((id, i) => ({
      id, vector: this._readVec(col, i), metadata: entry.meta[i],
    }));
  }
}

// ---------------------------------------------------------------------------
// IVF INDEX — OPTIMIZED (K-means sobre flat buffer)
// ---------------------------------------------------------------------------

class IVFIndex {
  constructor(store, numClusters = 100, numProbes = 10) {
    this.store       = store;
    this.numClusters = numClusters;
    this.numProbes   = numProbes;
    this._indexes    = new Map();
  }

  _indexFile(col) { return `${col}.ivf.json`; }

  _kmeansInit(flat, n, dim, k) {
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

  _kmeans(flat, n, dim, k, maxIter = 20) {
    const actualK    = Math.min(k, n);
    let centroids    = this._kmeansInit(flat, n, dim, actualK);
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
      const sums   = new Float64Array(actualK * dim);
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
    for (let c = 0; c < actualK; c++) {
      centroidArrays.push(Array.from(centroids.subarray(c * dim, (c + 1) * dim)));
    }
    return { centroids: centroidArrays, assignments: Array.from(assignments) };
  }

  build(col, sampleDims = 128) {
    const entry = this.store._load(col);
    const n     = entry.ids.length;
    if (n === 0) throw new Error(`Colección vacía: ${col}`);
    if (entry.pending && entry.pending.length > 0) this.store._flushCol(col, entry);

    const dim = this.store.dim;
    let flat;

    if (this.store instanceof BinaryQuantizedStore) {
      // Dequantizar 1-bit a flat Float64Array
      flat = new Float64Array(n * dim);
      const bpv = this.store._bpv;
      for (let i = 0; i < n; i++) {
        const vec = BinaryQuantizedStore.dequantize(entry.bin, i * bpv, dim);
        const iOff = i * dim;
        for (let d = 0; d < dim; d++) flat[iOff + d] = vec[d];
      }
    } else if (this.store instanceof QuantizedStore) {
      flat = new Float64Array(n * dim);
      const stride = this.store._stride;
      for (let i = 0; i < n; i++) {
        const offset = i * stride;
        const view   = new DataView(entry.bin);
        const min    = view.getFloat32(offset, true);
        const max    = view.getFloat32(offset + 4, true);
        const int8   = new Int8Array(entry.bin, offset + 8, dim);
        const range  = max - min || 1;
        const iOff   = i * dim;
        for (let d = 0; d < dim; d++) {
          flat[iOff + d] = ((int8[d] + 128) / 255) * range + min;
        }
      }
    } else {
      flat = new Float64Array(n * dim);
      const f32 = new Float32Array(entry.bin);
      for (let i = 0; i < n * dim; i++) flat[i] = f32[i];
    }

    const { centroids, assignments } = this._kmeans(flat, n, dim, this.numClusters);
    const index = { centroids, assignments, sampleDims };
    this._indexes.set(col, index);
    this.store._adapter.writeJson(this._indexFile(col), {
      centroids, assignments, sampleDims,
      numClusters: centroids.length,
      numProbes:   this.numProbes,
    });
    return { numClusters: centroids.length, numVectors: n };
  }

  _loadIndex(col) {
    if (this._indexes.has(col)) return this._indexes.get(col);
    const data = this.store._adapter.readJson(this._indexFile(col));
    if (!data) return null;
    this._indexes.set(col, data);
    return data;
  }

  hasIndex(col)   { return !!this._loadIndex(col); }
  dropIndex(col)  { this._indexes.delete(col); this.store._adapter.delete(this._indexFile(col)); }

  indexStats(col) {
    const idx = this._loadIndex(col);
    if (!idx) return null;
    return { numClusters: idx.centroids.length, numProbes: this.numProbes };
  }

  _getCandidates(col, query) {
    const idx  = this._loadIndex(col);
    if (!idx) throw new Error(`No hay índice IVF para: ${col}. Llamá a .build() primero.`);
    const { centroids, assignments } = idx;
    const dims = idx.sampleDims ?? query.length;
    const centDists = centroids.map((c, i) => ({ i, d: euclideanDist(query, c, dims) }));
    centDists.sort((a, b) => a.d - b.d);
    const probeClusters = new Set(centDists.slice(0, this.numProbes).map(x => x.i));
    const entry = this.store._load(col);
    const candidateIdxs = [];
    for (let i = 0; i < assignments.length; i++) {
      if (probeClusters.has(assignments[i])) candidateIdxs.push(i);
    }
    return { entry, candidateIdxs };
  }

  search(col, query, limit = 5) {
    const { entry, candidateIdxs } = this._getCandidates(col, query);
    const heap = new TopKHeap(limit);
    for (const idx of candidateIdxs) {
      const vec   = this.store._readVec(col, idx);
      const score = cosineSim(query, vec);
      heap.push({ id: entry.ids[idx], score, metadata: entry.meta[idx] });
    }
    return heap.sorted();
  }

  matryoshkaSearch(col, query, limit = 5, stages = [128, 256, 384]) {
    const { entry, candidateIdxs } = this._getCandidates(col, query);
    if (candidateIdxs.length === 0) return [];
    const factor = 4;
    let candidates = candidateIdxs.map(idx => ({
      id: entry.ids[idx], idx, metadata: entry.meta[idx],
    }));
    for (let s = 0; s < stages.length; s++) {
      const dims  = Math.min(stages[s], this.store.dim);
      const keepN = s < stages.length - 1
        ? Math.max(limit * factor * (stages.length - s), limit) : limit;
      const heap = new TopKHeap(keepN);
      for (const c of candidates) {
        const vec   = this.store._readVec(col, c.idx);
        const score = cosineSim(query, vec, dims);
        heap.push({ ...c, score });
      }
      candidates = heap.sorted();
    }
    return candidates.slice(0, limit).map(({ id, score, metadata }) => ({ id, score, metadata }));
  }
}

// ---------------------------------------------------------------------------
// CLOUDFLARE KV ADAPTER (para Workers)
// ---------------------------------------------------------------------------
// Requiere un binding KV de Cloudflare Workers.
// Uso: new VectorStore(new CloudflareKVAdapter(env.MY_KV, 'prefix/'), 768)
//
// Todas las operaciones son async en KV, pero los stores operan sync internamente.
// Este adapter carga todo en memoria al primer acceso y escribe a KV en flush().
// Para uso en Workers: llamar await adapter.preload(collections) al inicio del request.

class CloudflareKVAdapter {
  /**
   * @param {KVNamespace} kv  Binding de Cloudflare KV
   * @param {string} [prefix]  Prefijo para las keys (ej: 'vectors/')
   */
  constructor(kv, prefix = '') {
    this.kv     = kv;
    this.prefix = prefix;
    this._cache = new Map(); // key → { type: 'bin'|'json', data }
  }

  _key(filename) { return this.prefix + filename; }

  /**
   * Precarga colecciones desde KV a memoria.
   * Llamar al inicio del request con los nombres de archivos esperados.
   * @param {string[]} filenames  Ej: ['docs.bin', 'docs.json']
   */
  async preload(filenames) {
    const promises = filenames.map(async (f) => {
      const key = this._key(f);
      if (f.endsWith('.json')) {
        const val = await this.kv.get(key, 'json');
        if (val) this._cache.set(f, { type: 'json', data: val });
      } else {
        const val = await this.kv.get(key, 'arrayBuffer');
        if (val) this._cache.set(f, { type: 'bin', data: val });
      }
    });
    await Promise.all(promises);
  }

  readBin(filename) {
    const cached = this._cache.get(filename);
    return cached && cached.type === 'bin' ? cached.data : null;
  }

  writeBin(filename, buffer) {
    this._cache.set(filename, { type: 'bin', data: buffer });
  }

  readJson(filename) {
    const cached = this._cache.get(filename);
    return cached && cached.type === 'json' ? cached.data : null;
  }

  writeJson(filename, data) {
    this._cache.set(filename, { type: 'json', data });
  }

  delete(filename) {
    this._cache.delete(filename);
  }

  /**
   * Persiste todos los cambios en cache a Cloudflare KV.
   * Llamar despues de store.flush().
   */
  async persist() {
    const promises = [];
    for (const [filename, entry] of this._cache) {
      const key = this._key(filename);
      if (entry.type === 'json') {
        promises.push(this.kv.put(key, JSON.stringify(entry.data)));
      } else {
        promises.push(this.kv.put(key, entry.data));
      }
    }
    await Promise.all(promises);
  }

  /**
   * Elimina una key de KV.
   */
  async deleteFromKV(filename) {
    this._cache.delete(filename);
    await this.kv.delete(this._key(filename));
  }
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  VectorStore,
  QuantizedStore,
  BinaryQuantizedStore,
  IVFIndex,
  FileStorageAdapter,
  MemoryStorageAdapter,
  CloudflareKVAdapter,
  TopKHeap,
  // Math utils
  normalize,
  cosineSim,
  euclideanDist,
  dotProduct,
  manhattanDist,
  computeScore,
};
