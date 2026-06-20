'use strict';
// Property-test CONGELADO de matchFilter (issue #15). Oráculo INDEPENDIENTE: una copia de la
// semántica ORIGINAL (el switch por operador) que NO importa nada del target. Asegura que el
// refactor (tablas de despacho) es equivalente byte-a-byte en comportamiento.
//
// Estrategia: casos fijos por operador + 5000 casos aleatorios con semilla fija (no gameables).
// Falla (exit 1) ante la primera divergencia entre matchFilter y el oráculo.

const { matchFilter } = require('../../js-vector-store.js');

// --- Oráculo independiente: reimplementación congelada de la semántica original ---------------
function oracle(metadata, filter) {
  if (!filter || typeof filter !== 'object') return true;
  if (!metadata) metadata = {};
  for (const key of Object.keys(filter)) {
    if (key === '$and') {
      if (!Array.isArray(filter.$and)) return false;
      for (const sub of filter.$and) if (!oracle(metadata, sub)) return false;
      continue;
    }
    if (key === '$or') {
      if (!Array.isArray(filter.$or)) return false;
      let any = false;
      for (const sub of filter.$or) if (oracle(metadata, sub)) { any = true; break; }
      if (!any) return false;
      continue;
    }
    if (key === '$not') {
      if (oracle(metadata, filter.$not)) return false;
      continue;
    }
    const val = metadata[key];
    const cond = filter[key];
    if (cond === null || typeof cond !== 'object') {
      if (val !== cond) return false;
      continue;
    }
    for (const op of Object.keys(cond)) {
      const target = cond[op];
      switch (op) {
        case '$eq':     if (val !== target) return false; break;
        case '$ne':     if (val === target) return false; break;
        case '$gt':     if (!(val > target)) return false; break;
        case '$gte':    if (!(val >= target)) return false; break;
        case '$lt':     if (!(val < target)) return false; break;
        case '$lte':    if (!(val <= target)) return false; break;
        case '$in':     if (!Array.isArray(target) || !target.includes(val)) return false; break;
        case '$nin':    if (Array.isArray(target) && target.includes(val)) return false; break;
        case '$exists': if ((val !== undefined) !== target) return false; break;
        case '$regex': {
          const re = typeof target === 'string' ? new RegExp(target) : target;
          if (!re.test(String(val ?? ''))) return false;
          break;
        }
        default: break;
      }
    }
  }
  return true;
}

// --- RNG determinista (mulberry32, semilla fija) ---------------------------------------------
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let fail = 0;
function check(metadata, filter, label) {
  const a = matchFilter(metadata, filter);
  const b = oracle(metadata, filter);
  if (a !== b) {
    fail++;
    if (fail <= 10) {
      console.error('DIVERGENCIA', label || '', 'got', a, 'oracle', b,
        '\n  meta=', JSON.stringify(metadata), '\n  filter=', JSON.stringify(filter));
    }
  }
}

// --- Casos fijos: cada operador, valores frontera -------------------------------------------
const fixed = [
  [{ a: 1 }, { a: 1 }], [{ a: 1 }, { a: 2 }], [{ a: 1 }, { a: { $eq: 1 } }],
  [{ a: 1 }, { a: { $ne: 2 } }], [{ a: 3 }, { a: { $gt: 2 } }], [{ a: 2 }, { a: { $gte: 2 } }],
  [{ a: 1 }, { a: { $lt: 2 } }], [{ a: 2 }, { a: { $lte: 2 } }],
  [{ a: 2 }, { a: { $in: [1, 2, 3] } }], [{ a: 5 }, { a: { $in: 5 } }],
  [{ a: 2 }, { a: { $nin: [1, 2] } }], [{ a: 9 }, { a: { $nin: 'x' } }],
  [{ a: 1 }, { a: { $exists: true } }], [{}, { a: { $exists: false } }],
  [{ a: 'hello' }, { a: { $regex: '^he' } }], [{ a: 'x' }, { a: { $regex: /Y/i } }],
  [{ a: 1, b: 2 }, { a: 1, b: 2 }], [{ a: 1, b: 2 }, { a: 1, b: 3 }],
  [{ a: 1 }, { $and: [{ a: 1 }, { a: { $gt: 0 } }] }],
  [{ a: 1 }, { $or: [{ a: 9 }, { a: 1 }] }],
  [{ a: 1 }, { $not: { a: 2 } }], [{ a: 1 }, { $and: 'no-array' }],
  [{ a: 1 }, { a: null }], [{ a: null }, { a: null }], [{ a: 1 }, {}],
  [{ a: 1 }, { a: { $unknownOp: 5 } }], [{ a: NaN }, { a: { $gt: 0 } }],
];
fixed.forEach(([m, f], i) => check(m, f, `fixed#${i}`));

// --- Aleatorio con semilla fija --------------------------------------------------------------
const rand = rng(987654321);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const VALUES = [0, 1, 2, 3, -1, NaN, 'a', 'b', 'hello', true, false, null, undefined, 'X', 10];
const KEYS = ['a', 'b', 'c'];
const OPS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$exists', '$regex'];

function randMeta() {
  const m = {};
  for (const k of KEYS) if (rand() < 0.7) m[k] = pick(VALUES);
  return m;
}
function randCond() {
  const r = rand();
  if (r < 0.4) return pick(VALUES);                       // igualdad simple
  const op = pick(OPS);
  if (op === '$in' || op === '$nin') return { [op]: rand() < 0.8 ? [pick(VALUES), pick(VALUES)] : pick(VALUES) };
  if (op === '$exists') return { [op]: rand() < 0.5 };
  if (op === '$regex') return { [op]: pick(['^a', 'b', 'X', 'hel', '\\d']) };
  return { [op]: pick(VALUES) };
}
function randFilter(depth) {
  const r = rand();
  if (depth < 2 && r < 0.25) return { $and: [randFilter(depth + 1), randFilter(depth + 1)] };
  if (depth < 2 && r < 0.4) return { $or: [randFilter(depth + 1), randFilter(depth + 1)] };
  if (depth < 2 && r < 0.5) return { $not: randFilter(depth + 1) };
  const f = {};
  for (const k of KEYS) if (rand() < 0.5) f[k] = randCond();
  return f;
}

const N = 5000;
for (let i = 0; i < N; i++) check(randMeta(), randFilter(0), `rand#${i}`);

if (fail > 0) {
  console.error(`\nFAIL: ${fail} divergencias entre matchFilter y el oráculo`);
  process.exit(1);
}
console.log(`OK: matchFilter == oráculo en ${fixed.length} casos fijos + ${N} aleatorios`);
