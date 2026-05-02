// Test for multi-tenant collectionPrefix on QuantizedStore / BinaryQuantizedStore /
// PolarQuantizedStore (follow-up to issue #3, builds on PR #5).
// Run: node test-multi-tenant-quantized.js

const {
  QuantizedStore, BinaryQuantizedStore, PolarQuantizedStore,
  MemoryStorageAdapter, CloudflareKVAdapter,
} = require('./js-vector-store');

let passed = 0, failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };
const assertEq = (a, b, msg) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || 'mismatch'}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(b)}`);
  }
};

class MockKV {
  constructor() { this._store = new Map(); this._listLimit = 1000; }
  async get(key, type) {
    const v = this._store.get(key);
    if (v == null) return null;
    if (type === 'json') return JSON.parse(v);
    if (type === 'arrayBuffer') return v;
    return v;
  }
  async put(key, val) {
    if (val instanceof ArrayBuffer) this._store.set(key, val);
    else this._store.set(key, typeof val === 'string' ? val : JSON.stringify(val));
  }
  async delete(key) { this._store.delete(key); }
  async list({ prefix = '', cursor } = {}) {
    const all = [...this._store.keys()].filter(k => k.startsWith(prefix)).sort();
    const start = cursor ? parseInt(cursor, 10) : 0;
    const slice = all.slice(start, start + this._listLimit);
    const next = start + this._listLimit;
    if (next >= all.length) return { keys: slice.map(name => ({ name })), list_complete: true };
    return { keys: slice.map(name => ({ name })), list_complete: false, cursor: String(next) };
  }
}

const seedRandom = (store, col, n, dim) => {
  for (let i = 0; i < n; i++) {
    const v = new Array(dim).fill(0).map(() => Math.random() - 0.5);
    store.set(col, `id_${i}`, v, { i });
  }
};

(async () => {
  console.log('Multi-tenant collectionPrefix on quantized stores\n');
  const dim = 16;

  // ── QuantizedStore (Int8) ──────────────────────────────
  console.log('QuantizedStore (Int8):');

  await test('  backward compat: no prefix → .q8.{bin,json} unchanged', () => {
    const adapter = new MemoryStorageAdapter();
    const store = new QuantizedStore(adapter, dim);
    seedRandom(store, 'docs', 5, dim);
    store.flush();
    const keys = adapter.listKeys();
    assert(keys.includes('docs.q8.json'), 'expected docs.q8.json');
    assert(keys.includes('docs.q8.bin'), 'expected docs.q8.bin');
    assert(!keys.some(k => k.includes('/')), 'no prefix expected');
  });

  await test('  with prefix → tenant_a/docs.q8.{bin,json}', () => {
    const adapter = new MemoryStorageAdapter();
    const store = new QuantizedStore(adapter, dim, { collectionPrefix: 'tenant_a/' });
    seedRandom(store, 'docs', 5, dim);
    store.flush();
    const keys = adapter.listKeys();
    assert(keys.includes('tenant_a/docs.q8.json'));
    assert(keys.includes('tenant_a/docs.q8.bin'));
  });

  await test('  listCollections() respects prefix and .q8 extension', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = new QuantizedStore(adapter, dim, { collectionPrefix: 'tenant_a/' });
    seedRandom(store, 'docs', 5, dim);
    seedRandom(store, 'orders', 3, dim);
    store.flush();
    const cols = await store.listCollections();
    assertEq(cols, ['docs', 'orders']);
  });

  await test('  isolation between 2 tenants on shared adapter', async () => {
    const adapter = new MemoryStorageAdapter();
    const a = new QuantizedStore(adapter, dim, { collectionPrefix: 'a/' });
    const b = new QuantizedStore(adapter, dim, { collectionPrefix: 'b/' });
    seedRandom(a, 'docs', 5, dim);
    seedRandom(b, 'docs', 3, dim);
    a.flush(); b.flush();
    assertEq(await a.listCollections(), ['docs']);
    assertEq(await b.listCollections(), ['docs']);
    assert(a.count('docs') === 5);
    assert(b.count('docs') === 3);
  });

  await test('  dropAll() respects prefix', async () => {
    const adapter = new MemoryStorageAdapter();
    const a = new QuantizedStore(adapter, dim, { collectionPrefix: 'a/' });
    const b = new QuantizedStore(adapter, dim, { collectionPrefix: 'b/' });
    seedRandom(a, 'docs', 5, dim);
    seedRandom(b, 'docs', 4, dim);
    a.flush(); b.flush();
    const dropped = await a.dropAll();
    assertEq(dropped, ['docs']);
    assertEq(await a.listCollections(), []);
    assertEq(await b.listCollections(), ['docs']);
    assert(b.count('docs') === 4);
  });

  // ── BinaryQuantizedStore (1-bit) ────────────────────────
  console.log('\nBinaryQuantizedStore (1-bit):');

  await test('  backward compat: no prefix → .b1.{bin,json}', () => {
    const adapter = new MemoryStorageAdapter();
    const store = new BinaryQuantizedStore(adapter, dim);
    seedRandom(store, 'docs', 5, dim);
    store.flush();
    const keys = adapter.listKeys();
    assert(keys.includes('docs.b1.json'));
    assert(keys.includes('docs.b1.bin'));
  });

  await test('  with prefix → composes correctly', () => {
    const adapter = new MemoryStorageAdapter();
    const store = new BinaryQuantizedStore(adapter, dim, { collectionPrefix: 'pub_x/' });
    seedRandom(store, 'docs', 3, dim);
    store.flush();
    assert(adapter.listKeys().includes('pub_x/docs.b1.json'));
  });

  await test('  listCollections + isolation', async () => {
    const adapter = new MemoryStorageAdapter();
    const a = new BinaryQuantizedStore(adapter, dim, { collectionPrefix: 'a/' });
    const b = new BinaryQuantizedStore(adapter, dim, { collectionPrefix: 'b/' });
    seedRandom(a, 'docs', 5, dim);
    seedRandom(a, 'logs', 2, dim);
    seedRandom(b, 'docs', 3, dim);
    a.flush(); b.flush();
    assertEq(await a.listCollections(), ['docs', 'logs']);
    assertEq(await b.listCollections(), ['docs']);
  });

  // ── PolarQuantizedStore (3-bit) ─────────────────────────
  console.log('\nPolarQuantizedStore (3-bit):');

  await test('  backward compat: no prefix → .p3.{bin,json}', () => {
    const adapter = new MemoryStorageAdapter();
    const store = new PolarQuantizedStore(adapter, dim);
    seedRandom(store, 'docs', 5, dim);
    store.flush();
    const keys = adapter.listKeys();
    assert(keys.includes('docs.p3.json'));
    assert(keys.includes('docs.p3.bin'));
  });

  await test('  with prefix → composes correctly', () => {
    const adapter = new MemoryStorageAdapter();
    const store = new PolarQuantizedStore(adapter, dim, { collectionPrefix: 'pub_y/' });
    seedRandom(store, 'docs', 3, dim);
    store.flush();
    assert(adapter.listKeys().includes('pub_y/docs.p3.json'));
  });

  await test('  listCollections + isolation', async () => {
    const adapter = new MemoryStorageAdapter();
    const a = new PolarQuantizedStore(adapter, dim, { collectionPrefix: 'a/' });
    const b = new PolarQuantizedStore(adapter, dim, { collectionPrefix: 'b/' });
    seedRandom(a, 'docs', 5, dim);
    seedRandom(b, 'docs', 3, dim);
    a.flush(); b.flush();
    assertEq(await a.listCollections(), ['docs']);
    assertEq(await b.listCollections(), ['docs']);
    assert(a.count('docs') === 5);
    assert(b.count('docs') === 3);
  });

  // ── Cross-store isolation (same prefix, different stores share adapter) ──
  console.log('\nCross-store isolation:');

  await test('  3 store types coexist on same adapter without seeing each other', async () => {
    const adapter = new MemoryStorageAdapter();
    const q = new QuantizedStore(adapter, dim, { collectionPrefix: 'shared/' });
    const b = new BinaryQuantizedStore(adapter, dim, { collectionPrefix: 'shared/' });
    const p = new PolarQuantizedStore(adapter, dim, { collectionPrefix: 'shared/' });

    seedRandom(q, 'docs', 5, dim);
    seedRandom(b, 'logs', 3, dim);
    seedRandom(p, 'cache', 2, dim);
    q.flush(); b.flush(); p.flush();

    // Each store's listCollections only sees its own extension family
    assertEq(await q.listCollections(), ['docs']);
    assertEq(await b.listCollections(), ['logs']);
    assertEq(await p.listCollections(), ['cache']);
  });

  // ── CloudflareKVAdapter integration ─────────────────────
  console.log('\nCloudflareKVAdapter integration:');

  await test('  QuantizedStore + KV: listCollections roundtrip', async () => {
    const kv = new MockKV();
    const adapter = new CloudflareKVAdapter(kv, 'glosa/');
    const store = new QuantizedStore(adapter, dim, { collectionPrefix: 'tenant_z/' });
    seedRandom(store, 'docs', 4, dim);
    seedRandom(store, 'tags', 2, dim);
    store.flush();
    await adapter.persist();

    // Re-open
    const a2 = new CloudflareKVAdapter(kv, 'glosa/');
    const store2 = new QuantizedStore(a2, dim, { collectionPrefix: 'tenant_z/' });
    assertEq(await store2.listCollections(), ['docs', 'tags']);

    // Raw KV keys verify composition
    const rawKeys = [...kv._store.keys()];
    assert(rawKeys.includes('glosa/tenant_z/docs.q8.json'));
    assert(rawKeys.includes('glosa/tenant_z/docs.q8.bin'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
