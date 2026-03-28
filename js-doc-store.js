/**
 * js-doc-store
 * Document database en vanilla JS — zero dependencias
 * Corre en Node.js, browser, Cloudflare Workers, Deno, Bun
 *
 * Queries estilo MongoDB con indices, aggregation, y cursores.
 * Mismo patron de storage adapters que js-vector-store.
 */

// ---------------------------------------------------------------------------
// ID GENERATOR
// ---------------------------------------------------------------------------

let _idCounter = 0;
function generateId() {
  const ts  = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  const seq = (++_idCounter).toString(36);
  return `${ts}-${rnd}-${seq}`;
}

// ---------------------------------------------------------------------------
// MATCH FILTER (query engine)
// ---------------------------------------------------------------------------

function matchFilter(doc, filter) {
  if (!filter || typeof filter !== 'object') return true;
  if (!doc) doc = {};

  for (const key of Object.keys(filter)) {
    if (key === '$and') {
      if (!Array.isArray(filter.$and)) return false;
      for (const sub of filter.$and) { if (!matchFilter(doc, sub)) return false; }
      continue;
    }
    if (key === '$or') {
      if (!Array.isArray(filter.$or)) return false;
      let any = false;
      for (const sub of filter.$or) { if (matchFilter(doc, sub)) { any = true; break; } }
      if (!any) return false;
      continue;
    }
    if (key === '$not') {
      if (matchFilter(doc, filter.$not)) return false;
      continue;
    }

    const val  = _getNestedValue(doc, key);
    const cond = filter[key];

    if (cond === null || cond === undefined || typeof cond !== 'object' || cond instanceof RegExp) {
      if (cond instanceof RegExp) { if (!cond.test(String(val ?? ''))) return false; }
      else if (val !== cond) return false;
      continue;
    }

    for (const op of Object.keys(cond)) {
      const target = cond[op];
      switch (op) {
        case '$eq':      if (val !== target) return false; break;
        case '$ne':      if (val === target) return false; break;
        case '$gt':      if (!(val > target)) return false; break;
        case '$gte':     if (!(val >= target)) return false; break;
        case '$lt':      if (!(val < target)) return false; break;
        case '$lte':     if (!(val <= target)) return false; break;
        case '$in':      if (!Array.isArray(target) || !target.includes(val)) return false; break;
        case '$nin':     if (Array.isArray(target) && target.includes(val)) return false; break;
        case '$exists':  if ((val !== undefined) !== target) return false; break;
        case '$regex': {
          const re = typeof target === 'string' ? new RegExp(target) : target;
          if (!re.test(String(val ?? ''))) return false;
          break;
        }
        case '$contains': {
          if (!Array.isArray(val) || !val.includes(target)) return false;
          break;
        }
        case '$size': {
          if (!Array.isArray(val) || val.length !== target) return false;
          break;
        }
        default: break;
      }
    }
  }
  return true;
}

/** Accede a valores anidados con dot notation: 'address.city' */
function _getNestedValue(obj, path) {
  if (!path.includes('.')) return obj[path];
  const parts = path.split('.');
  let current = obj;
  for (const p of parts) {
    if (current == null) return undefined;
    current = current[p];
  }
  return current;
}

function _setNestedValue(obj, path, value) {
  if (!path.includes('.')) { obj[path] = value; return; }
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

function _deleteNestedValue(obj, path) {
  if (!path.includes('.')) { delete obj[path]; return; }
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null) return;
    current = current[parts[i]];
  }
  delete current[parts[parts.length - 1]];
}

// ---------------------------------------------------------------------------
// UPDATE OPERATORS
// ---------------------------------------------------------------------------

function applyUpdate(doc, update) {
  const result = JSON.parse(JSON.stringify(doc)); // deep clone

  for (const op of Object.keys(update)) {
    const fields = update[op];

    switch (op) {
      case '$set':
        for (const [k, v] of Object.entries(fields)) _setNestedValue(result, k, v);
        break;

      case '$unset':
        for (const k of Object.keys(fields)) _deleteNestedValue(result, k);
        break;

      case '$inc':
        for (const [k, v] of Object.entries(fields)) {
          const cur = _getNestedValue(result, k) || 0;
          _setNestedValue(result, k, cur + v);
        }
        break;

      case '$push':
        for (const [k, v] of Object.entries(fields)) {
          const arr = _getNestedValue(result, k);
          if (Array.isArray(arr)) arr.push(v);
          else _setNestedValue(result, k, [v]);
        }
        break;

      case '$pull':
        for (const [k, v] of Object.entries(fields)) {
          const arr = _getNestedValue(result, k);
          if (Array.isArray(arr)) {
            const idx = arr.indexOf(v);
            if (idx >= 0) arr.splice(idx, 1);
          }
        }
        break;

      case '$rename':
        for (const [oldKey, newKey] of Object.entries(fields)) {
          const val = _getNestedValue(result, oldKey);
          if (val !== undefined) {
            _setNestedValue(result, newKey, val);
            _deleteNestedValue(result, oldKey);
          }
        }
        break;

      default:
        // Si no tiene operador, tratar como reemplazo completo (excepto _id)
        if (!op.startsWith('$')) {
          const id = result._id;
          Object.assign(result, update);
          result._id = id;
          return result;
        }
    }
  }
  return result;
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
      throw new Error('DocStore: entorno sin fs — usa un StorageAdapter personalizado');
    }
  }
  return { fs: _fs, path: _path };
}

class FileStorageAdapter {
  constructor(dir) {
    const { fs, path } = _getFs();
    this.dir = dir; this.fs = fs; this.path = path;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  constructor() { this._data = new Map(); }
  readJson(k)      { return this._data.get(k) ?? null; }
  writeJson(k, v)  { this._data.set(k, v); }
  delete(k)        { this._data.delete(k); }
}

class CloudflareKVAdapter {
  constructor(kv, prefix = '') {
    this.kv = kv; this.prefix = prefix; this._cache = new Map();
  }
  _key(f) { return this.prefix + f; }
  async preload(filenames) {
    const promises = filenames.map(async (f) => {
      const val = await this.kv.get(this._key(f), 'json');
      if (val) this._cache.set(f, val);
    });
    await Promise.all(promises);
  }
  readJson(f)     { return this._cache.get(f) ?? null; }
  writeJson(f, v) { this._cache.set(f, v); }
  delete(f)       { this._cache.delete(f); }
  async persist() {
    const promises = [];
    for (const [f, v] of this._cache) {
      promises.push(this.kv.put(this._key(f), JSON.stringify(v)));
    }
    await Promise.all(promises);
  }
  async deleteFromKV(f) {
    this._cache.delete(f);
    await this.kv.delete(this._key(f));
  }
}

// ---------------------------------------------------------------------------
// HASH INDEX
// ---------------------------------------------------------------------------

class HashIndex {
  constructor(field, opts = {}) {
    this.field  = field;
    this.unique = !!opts.unique;
    this._map   = new Map(); // value → Set<_id>
  }

  add(doc) {
    const val = _getNestedValue(doc, this.field);
    if (val === undefined) return;
    const key = String(val);

    if (this.unique && this._map.has(key)) {
      const existing = this._map.get(key);
      if (existing.size > 0 && !existing.has(doc._id)) {
        throw new Error(`Unique constraint violated: ${this.field} = "${val}"`);
      }
    }

    if (!this._map.has(key)) this._map.set(key, new Set());
    this._map.get(key).add(doc._id);
  }

  remove(doc) {
    const val = _getNestedValue(doc, this.field);
    if (val === undefined) return;
    const key = String(val);
    const set = this._map.get(key);
    if (set) {
      set.delete(doc._id);
      if (set.size === 0) this._map.delete(key);
    }
  }

  lookup(value) {
    const set = this._map.get(String(value));
    return set ? Array.from(set) : [];
  }

  has(value) {
    const set = this._map.get(String(value));
    return set ? set.size > 0 : false;
  }

  clear() { this._map.clear(); }

  rebuild(docs) {
    this._map.clear();
    for (const doc of docs) this.add(doc);
  }

  exportState() {
    const obj = {};
    for (const [k, v] of this._map) obj[k] = Array.from(v);
    return { field: this.field, unique: this.unique, data: obj };
  }

  importState(state) {
    this._map.clear();
    for (const [k, ids] of Object.entries(state.data)) {
      this._map.set(k, new Set(ids));
    }
  }
}

// ---------------------------------------------------------------------------
// SORTED INDEX
// ---------------------------------------------------------------------------

class SortedIndex {
  constructor(field) {
    this.field   = field;
    this._entries = []; // sorted array of { value, _id }
  }

  add(doc) {
    const val = _getNestedValue(doc, this.field);
    if (val === undefined) return;
    const entry = { value: val, _id: doc._id };
    // Binary search insert
    let lo = 0, hi = this._entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this._entries[mid].value < val) lo = mid + 1;
      else hi = mid;
    }
    this._entries.splice(lo, 0, entry);
  }

  remove(doc) {
    const val = _getNestedValue(doc, this.field);
    if (val === undefined) return;
    // Find and remove
    for (let i = 0; i < this._entries.length; i++) {
      if (this._entries[i]._id === doc._id && this._entries[i].value === val) {
        this._entries.splice(i, 1);
        return;
      }
    }
  }

  /** Range query: retorna _ids donde value esta en [min, max]. */
  range(min, max, opts = {}) {
    const excludeMin = !!opts.excludeMin;
    const excludeMax = !!opts.excludeMax;

    // Binary search for start
    let lo = 0, hi = this._entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (excludeMin ? this._entries[mid].value <= min : this._entries[mid].value < min) lo = mid + 1;
      else hi = mid;
    }

    const ids = [];
    for (let i = lo; i < this._entries.length; i++) {
      const v = this._entries[i].value;
      if (excludeMax ? v >= max : v > max) break;
      ids.push(this._entries[i]._id);
    }
    return ids;
  }

  /** Retorna todos los _ids ordenados. asc=true ascendente. */
  all(asc = true) {
    if (asc) return this._entries.map(e => e._id);
    return this._entries.slice().reverse().map(e => e._id);
  }

  clear() { this._entries = []; }

  rebuild(docs) {
    this._entries = [];
    for (const doc of docs) this.add(doc);
  }

  exportState() {
    return { field: this.field, entries: this._entries };
  }

  importState(state) {
    this._entries = state.entries || [];
  }
}

// ---------------------------------------------------------------------------
// CURSOR (lazy query builder)
// ---------------------------------------------------------------------------

class Cursor {
  constructor(collection, filter) {
    this._col    = collection;
    this._filter = filter;
    this._sort   = null;
    this._skip   = 0;
    this._limit  = 0;
    this._proj   = null;
  }

  sort(spec)    { this._sort  = spec; return this; }
  skip(n)       { this._skip  = n;    return this; }
  limit(n)      { this._limit = n;    return this; }
  project(spec) { this._proj  = spec; return this; }

  toArray() {
    let docs = this._col._findDocs(this._filter);

    // Sort
    if (this._sort) {
      const fields = Object.entries(this._sort);
      docs.sort((a, b) => {
        for (const [field, dir] of fields) {
          const va = _getNestedValue(a, field);
          const vb = _getNestedValue(b, field);
          if (va < vb) return -dir;
          if (va > vb) return dir;
        }
        return 0;
      });
    }

    // Skip
    if (this._skip > 0) docs = docs.slice(this._skip);

    // Limit
    if (this._limit > 0) docs = docs.slice(0, this._limit);

    // Project
    if (this._proj) {
      const includeMode = Object.values(this._proj).some(v => v === 1);
      docs = docs.map(doc => {
        const result = { _id: doc._id };
        if (includeMode) {
          for (const [k, v] of Object.entries(this._proj)) {
            if (v === 1) result[k] = _getNestedValue(doc, k);
          }
        } else {
          Object.assign(result, JSON.parse(JSON.stringify(doc)));
          for (const [k, v] of Object.entries(this._proj)) {
            if (v === 0) delete result[k];
          }
        }
        return result;
      });
    }

    return docs;
  }

  first() {
    this._limit = 1;
    const arr = this.toArray();
    return arr.length > 0 ? arr[0] : null;
  }

  count() {
    return this._col._findDocs(this._filter).length;
  }

  forEach(fn) {
    this.toArray().forEach(fn);
  }

  map(fn) {
    return this.toArray().map(fn);
  }
}

// ---------------------------------------------------------------------------
// AGGREGATION PIPELINE
// ---------------------------------------------------------------------------

class AggregationPipeline {
  constructor(collection) {
    this._col    = collection;
    this._stages = [];
  }

  match(filter) {
    this._stages.push({ type: 'match', filter });
    return this;
  }

  group(field, accumulators) {
    this._stages.push({ type: 'group', field, accumulators });
    return this;
  }

  sort(spec) {
    this._stages.push({ type: 'sort', spec });
    return this;
  }

  limit(n) {
    this._stages.push({ type: 'limit', n });
    return this;
  }

  skip(n) {
    this._stages.push({ type: 'skip', n });
    return this;
  }

  project(spec) {
    this._stages.push({ type: 'project', spec });
    return this;
  }

  unwind(field) {
    this._stages.push({ type: 'unwind', field });
    return this;
  }

  toArray() {
    let docs = this._col._findDocs({});

    for (const stage of this._stages) {
      switch (stage.type) {
        case 'match':
          docs = docs.filter(d => matchFilter(d, stage.filter));
          break;

        case 'group': {
          const groups = new Map();
          for (const doc of docs) {
            const key = stage.field ? String(_getNestedValue(doc, stage.field) ?? '_null') : '_all';
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(doc);
          }

          docs = [];
          for (const [key, groupDocs] of groups) {
            const result = { _id: key };
            for (const [accName, accDef] of Object.entries(stage.accumulators)) {
              if (accDef.$count) {
                result[accName] = groupDocs.length;
              } else if (accDef.$sum) {
                result[accName] = groupDocs.reduce((s, d) => s + (Number(_getNestedValue(d, accDef.$sum)) || 0), 0);
              } else if (accDef.$avg) {
                const vals = groupDocs.map(d => Number(_getNestedValue(d, accDef.$avg)) || 0);
                result[accName] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
              } else if (accDef.$min) {
                result[accName] = Math.min(...groupDocs.map(d => Number(_getNestedValue(d, accDef.$min)) || Infinity));
              } else if (accDef.$max) {
                result[accName] = Math.max(...groupDocs.map(d => Number(_getNestedValue(d, accDef.$max)) || -Infinity));
              } else if (accDef.$push) {
                result[accName] = groupDocs.map(d => _getNestedValue(d, accDef.$push));
              } else if (accDef.$first) {
                result[accName] = _getNestedValue(groupDocs[0], accDef.$first);
              } else if (accDef.$last) {
                result[accName] = _getNestedValue(groupDocs[groupDocs.length - 1], accDef.$last);
              }
            }
            docs.push(result);
          }
          break;
        }

        case 'sort': {
          const fields = Object.entries(stage.spec);
          docs.sort((a, b) => {
            for (const [field, dir] of fields) {
              const va = _getNestedValue(a, field);
              const vb = _getNestedValue(b, field);
              if (va < vb) return -dir;
              if (va > vb) return dir;
            }
            return 0;
          });
          break;
        }

        case 'limit':
          docs = docs.slice(0, stage.n);
          break;

        case 'skip':
          docs = docs.slice(stage.n);
          break;

        case 'project': {
          const includeMode = Object.values(stage.spec).some(v => v === 1);
          docs = docs.map(doc => {
            const result = { _id: doc._id };
            if (includeMode) {
              for (const [k, v] of Object.entries(stage.spec)) {
                if (v === 1) result[k] = _getNestedValue(doc, k);
              }
            } else {
              Object.assign(result, JSON.parse(JSON.stringify(doc)));
              for (const [k, v] of Object.entries(stage.spec)) {
                if (v === 0) delete result[k];
              }
            }
            return result;
          });
          break;
        }

        case 'unwind': {
          const newDocs = [];
          for (const doc of docs) {
            const arr = _getNestedValue(doc, stage.field);
            if (Array.isArray(arr)) {
              for (const item of arr) {
                const copy = JSON.parse(JSON.stringify(doc));
                _setNestedValue(copy, stage.field, item);
                newDocs.push(copy);
              }
            } else {
              newDocs.push(doc);
            }
          }
          docs = newDocs;
          break;
        }
      }
    }

    return docs;
  }
}

// ---------------------------------------------------------------------------
// COLLECTION
// ---------------------------------------------------------------------------

class Collection {
  constructor(name, adapter) {
    this.name     = name;
    this._adapter = adapter;
    this._docs    = null;   // Map<_id, doc>
    this._indexes = new Map(); // fieldName → HashIndex | SortedIndex
    this._indexDefs = [];   // [{ field, type, unique }]
    this._dirty   = false;
    this._loaded  = false;
  }

  _dataFile()  { return `${this.name}.docs.json`; }
  _metaFile()  { return `${this.name}.meta.json`; }
  _indexFile(field, type) { return `${this.name}.${field}.${type === 'sorted' ? 'sidx' : 'idx'}.json`; }

  _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;

    // Load documents
    const data = this._adapter.readJson(this._dataFile());
    this._docs = new Map();
    if (Array.isArray(data)) {
      for (const doc of data) {
        if (doc && doc._id) this._docs.set(doc._id, doc);
      }
    }

    // Load metadata (index definitions)
    const meta = this._adapter.readJson(this._metaFile());
    if (meta && Array.isArray(meta.indexes)) {
      this._indexDefs = meta.indexes;
      for (const def of meta.indexes) {
        this._createIndexInternal(def.field, def.type || 'hash', !!def.unique, false);
      }
    }
  }

  // ── Index management ─────────────────────────────────────

  createIndex(field, opts = {}) {
    this._ensureLoaded();
    const type   = opts.type || 'hash';
    const unique = !!opts.unique;

    if (this._indexes.has(field)) {
      throw new Error(`Index already exists on field: ${field}`);
    }

    this._createIndexInternal(field, type, unique, true);

    // Save def
    this._indexDefs.push({ field, type, unique });
    this._dirty = true;
  }

  _createIndexInternal(field, type, unique, rebuild) {
    let index;
    if (type === 'sorted') {
      index = new SortedIndex(field);
    } else {
      index = new HashIndex(field, { unique });
    }

    // Try load from persisted state
    const state = this._adapter.readJson(this._indexFile(field, type));
    if (state && !rebuild) {
      index.importState(state);
    } else if (this._docs && this._docs.size > 0) {
      index.rebuild(Array.from(this._docs.values()));
    }

    this._indexes.set(field, index);
  }

  dropIndex(field) {
    this._ensureLoaded();
    const index = this._indexes.get(field);
    if (!index) return;
    this._indexes.delete(field);
    this._indexDefs = this._indexDefs.filter(d => d.field !== field);
    const type = index instanceof SortedIndex ? 'sorted' : 'hash';
    this._adapter.delete(this._indexFile(field, type));
    this._dirty = true;
  }

  getIndexes() {
    this._ensureLoaded();
    return this._indexDefs.slice();
  }

  // ── CRUD ─────────────────────────────────────────────────

  insert(doc) {
    this._ensureLoaded();
    const newDoc = JSON.parse(JSON.stringify(doc));
    if (!newDoc._id) newDoc._id = generateId();
    if (this._docs.has(newDoc._id)) {
      throw new Error(`Duplicate _id: ${newDoc._id}`);
    }

    // Check unique indexes before inserting
    for (const [, index] of this._indexes) {
      if (index instanceof HashIndex && index.unique) {
        const val = _getNestedValue(newDoc, index.field);
        if (val !== undefined && index.has(val)) {
          throw new Error(`Unique constraint violated: ${index.field} = "${val}"`);
        }
      }
    }

    this._docs.set(newDoc._id, newDoc);
    for (const [, index] of this._indexes) index.add(newDoc);
    this._dirty = true;
    return newDoc;
  }

  insertMany(docs) {
    const results = [];
    for (const doc of docs) results.push(this.insert(doc));
    return results;
  }

  findById(id) {
    this._ensureLoaded();
    const doc = this._docs.get(id);
    return doc ? JSON.parse(JSON.stringify(doc)) : null;
  }

  findOne(filter) {
    this._ensureLoaded();
    // Try index lookup for simple equality
    const indexResult = this._tryIndexLookup(filter);
    if (indexResult !== null) {
      for (const id of indexResult) {
        const doc = this._docs.get(id);
        if (doc && matchFilter(doc, filter)) return JSON.parse(JSON.stringify(doc));
      }
      return null;
    }

    for (const doc of this._docs.values()) {
      if (matchFilter(doc, filter)) return JSON.parse(JSON.stringify(doc));
    }
    return null;
  }

  find(filter = {}) {
    this._ensureLoaded();
    return new Cursor(this, filter);
  }

  /** Internal: retorna docs que matchean el filtro (usado por Cursor). */
  _findDocs(filter) {
    this._ensureLoaded();

    // Try index acceleration
    const indexResult = this._tryIndexLookup(filter);
    if (indexResult !== null) {
      const docs = [];
      for (const id of indexResult) {
        const doc = this._docs.get(id);
        if (doc && matchFilter(doc, filter)) docs.push(JSON.parse(JSON.stringify(doc)));
      }
      return docs;
    }

    // Full scan
    const docs = [];
    for (const doc of this._docs.values()) {
      if (matchFilter(doc, filter)) docs.push(JSON.parse(JSON.stringify(doc)));
    }
    return docs;
  }

  /** Intenta usar un indice para acelerar el filtro. Retorna null si no puede. */
  _tryIndexLookup(filter) {
    if (!filter || typeof filter !== 'object') return null;

    for (const [field, cond] of Object.entries(filter)) {
      if (field.startsWith('$')) continue;
      const index = this._indexes.get(field);
      if (!index) continue;

      // Hash index: igualdad directa
      if (index instanceof HashIndex) {
        if (cond === null || typeof cond !== 'object') {
          return index.lookup(cond);
        }
        if (cond.$eq !== undefined) return index.lookup(cond.$eq);
        if (cond.$in && Array.isArray(cond.$in)) {
          const ids = [];
          for (const v of cond.$in) ids.push(...index.lookup(v));
          return ids;
        }
      }

      // Sorted index: range queries
      if (index instanceof SortedIndex) {
        let min = -Infinity, max = Infinity;
        let excludeMin = false, excludeMax = false;

        if (typeof cond === 'object' && cond !== null) {
          if (cond.$gte !== undefined) { min = cond.$gte; excludeMin = false; }
          if (cond.$gt  !== undefined) { min = cond.$gt;  excludeMin = true; }
          if (cond.$lte !== undefined) { max = cond.$lte; excludeMax = false; }
          if (cond.$lt  !== undefined) { max = cond.$lt;  excludeMax = true; }

          if (min !== -Infinity || max !== Infinity) {
            return index.range(min, max, { excludeMin, excludeMax });
          }
        }

        // Equality on sorted index
        if (cond === null || typeof cond !== 'object') {
          return index.range(cond, cond);
        }
        if (cond.$eq !== undefined) return index.range(cond.$eq, cond.$eq);
      }
    }

    return null;
  }

  update(filter, update) {
    this._ensureLoaded();
    const doc = this.findOne(filter);
    if (!doc) return 0;
    return this._updateDoc(doc._id, update);
  }

  updateMany(filter, update) {
    this._ensureLoaded();
    const docs = this._findDocs(filter);
    let count = 0;
    for (const doc of docs) {
      count += this._updateDoc(doc._id, update);
    }
    return count;
  }

  _updateDoc(id, update) {
    const oldDoc = this._docs.get(id);
    if (!oldDoc) return 0;

    const newDoc = applyUpdate(oldDoc, update);
    newDoc._id = id; // preserve _id

    // Remove from indexes, re-add
    for (const [, index] of this._indexes) index.remove(oldDoc);

    // Check unique constraints
    for (const [, index] of this._indexes) {
      if (index instanceof HashIndex && index.unique) {
        const val = _getNestedValue(newDoc, index.field);
        if (val !== undefined && index.has(val)) {
          // Revert: re-add old doc to indexes
          for (const [, idx] of this._indexes) idx.add(oldDoc);
          throw new Error(`Unique constraint violated: ${index.field} = "${val}"`);
        }
      }
    }

    this._docs.set(id, newDoc);
    for (const [, index] of this._indexes) index.add(newDoc);
    this._dirty = true;
    return 1;
  }

  remove(filter) {
    this._ensureLoaded();
    const doc = this.findOne(filter);
    if (!doc) return 0;
    return this._removeDoc(doc._id);
  }

  removeMany(filter) {
    this._ensureLoaded();
    const docs = this._findDocs(filter);
    let count = 0;
    for (const doc of docs) count += this._removeDoc(doc._id);
    return count;
  }

  removeById(id) {
    this._ensureLoaded();
    return this._removeDoc(id);
  }

  _removeDoc(id) {
    const doc = this._docs.get(id);
    if (!doc) return 0;
    for (const [, index] of this._indexes) index.remove(doc);
    this._docs.delete(id);
    this._dirty = true;
    return 1;
  }

  count(filter) {
    this._ensureLoaded();
    if (!filter) return this._docs.size;
    return this._findDocs(filter).length;
  }

  // ── Aggregation ──────────────────────────────────────────

  aggregate() {
    this._ensureLoaded();
    return new AggregationPipeline(this);
  }

  // ── Persistence ──────────────────────────────────────────

  flush() {
    if (!this._dirty || !this._loaded) return;

    // Save documents
    const docs = Array.from(this._docs.values());
    this._adapter.writeJson(this._dataFile(), docs);

    // Save metadata
    this._adapter.writeJson(this._metaFile(), { indexes: this._indexDefs });

    // Save indexes
    for (const [field, index] of this._indexes) {
      const type = index instanceof SortedIndex ? 'sorted' : 'hash';
      this._adapter.writeJson(this._indexFile(field, type), index.exportState());
    }

    this._dirty = false;
  }

  clear() {
    this._ensureLoaded();
    this._docs.clear();
    for (const [, index] of this._indexes) index.clear();
    this._dirty = true;
  }

  /** Exporta todos los documentos como array. */
  export() {
    this._ensureLoaded();
    return Array.from(this._docs.values()).map(d => JSON.parse(JSON.stringify(d)));
  }

  /** Importa documentos (merge). */
  import(docs) {
    let count = 0;
    for (const doc of docs) {
      try {
        this.insert(doc);
        count++;
      } catch {
        // Skip duplicates
      }
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// DOC STORE (main entry point)
// ---------------------------------------------------------------------------

class DocStore {
  constructor(dirOrAdapter) {
    this._adapter = typeof dirOrAdapter === 'string'
      ? new FileStorageAdapter(dirOrAdapter)
      : dirOrAdapter;
    this._collections = new Map();
  }

  collection(name) {
    if (!this._collections.has(name)) {
      this._collections.set(name, new Collection(name, this._adapter));
    }
    return this._collections.get(name);
  }

  drop(name) {
    const col = this._collections.get(name);
    if (col) {
      col._ensureLoaded();
      // Delete all files
      this._adapter.delete(col._dataFile());
      this._adapter.delete(col._metaFile());
      for (const [field, index] of col._indexes) {
        const type = index instanceof SortedIndex ? 'sorted' : 'hash';
        this._adapter.delete(col._indexFile(field, type));
      }
    }
    this._collections.delete(name);
  }

  collections() {
    return Array.from(this._collections.keys());
  }

  flush() {
    for (const [, col] of this._collections) col.flush();
  }
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  DocStore,
  Collection,
  Cursor,
  AggregationPipeline,
  HashIndex,
  SortedIndex,
  FileStorageAdapter,
  MemoryStorageAdapter,
  CloudflareKVAdapter,
  // Utils
  matchFilter,
  applyUpdate,
  generateId,
};
