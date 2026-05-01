// Test for multi-tenant collectionPrefix on VectorStore (issue #3)
// Run: node test-multi-tenant.js

const { VectorStore, MemoryStorageAdapter, CloudflareKVAdapter } = require('./js-vector-store');

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

// ── Mock KVNamespace (matches Cloudflare API) ──
class MockKV {
  constructor() { this._store = new Map(); this._listLimit = 1000; }
  async get(key, type) {
    const v = this._store.get(key);
    if (v == null) return null;
    if (type === 'json') return JSON.parse(v);
    if (type === 'arrayBuffer') return v;  // already ArrayBuffer
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
  console.log('VectorStore multi-tenant tests\n');
  const dim = 16;

  // Backward compat: no prefix = previous behavior
  await test('backward compat: no prefix, files unprefixed', () => {
    const adapter = new MemoryStorageAdapter();
    const store = new VectorStore(adapter, dim);
    seedRandom(store, 'docs', 5, dim);
    store.flush();
    const keys = adapter.listKeys();
    assert(keys.includes('docs.json'), 'expected docs.json');
    assert(keys.includes('docs.bin'), 'expected docs.bin');
    assert(!keys.some(k => k.includes('/')), 'no prefix expected');
  });

  await test('with collectionPrefix, files are prefixed', () => {
    const adapter = new MemoryStorageAdapter();
    const store = new VectorStore(adapter, dim, 50, { collectionPrefix: 'tenant_a/' });
    seedRandom(store, 'docs', 5, dim);
    store.flush();
    const keys = adapter.listKeys();
    assert(keys.includes('tenant_a/docs.json'), `expected tenant_a/docs.json, got: ${keys}`);
    assert(keys.includes('tenant_a/docs.bin'), `expected tenant_a/docs.bin`);
  });

  await test('listCollections() returns names without prefix or extension', async () => {
    const adapter = new MemoryStorageAdapter();
    const store = new VectorStore(adapter, dim, 50, { collectionPrefix: 'tenant_a/' });
    seedRandom(store, 'docs', 5, dim);
    seedRandom(store, 'products', 3, dim);
    store.flush();
    const cols = await store.listCollections();
    assertEq(cols, ['docs', 'products']);
  });

  await test('multi-tenant isolation: 2 stores share adapter, dont see each other', async () => {
    const adapter = new MemoryStorageAdapter();
    const a = new VectorStore(adapter, dim, 50, { collectionPrefix: 'tenant_a/' });
    const b = new VectorStore(adapter, dim, 50, { collectionPrefix: 'tenant_b/' });

    seedRandom(a, 'docs', 5, dim);
    seedRandom(b, 'docs', 3, dim);
    a.flush(); b.flush();

    const aCols = await a.listCollections();
    const bCols = await b.listCollections();
    assertEq(aCols, ['docs']);
    assertEq(bCols, ['docs']);

    // But the underlying storage has both, segregated
    const allKeys = adapter.listKeys();
    const aFiles = allKeys.filter(k => k.startsWith('tenant_a/'));
    const bFiles = allKeys.filter(k => k.startsWith('tenant_b/'));
    assert(aFiles.length === 2, `expected 2 a-files, got ${aFiles.length}`);
    assert(bFiles.length === 2, `expected 2 b-files, got ${bFiles.length}`);

    // Tenant A counts must be its own (5), not affected by tenant B (3)
    assert(a.count('docs') === 5, `tenant a count wrong: ${a.count('docs')}`);
    assert(b.count('docs') === 3, `tenant b count wrong: ${b.count('docs')}`);
  });

  await test('dropAll() drops only this tenant\'s collections', async () => {
    const adapter = new MemoryStorageAdapter();
    const a = new VectorStore(adapter, dim, 50, { collectionPrefix: 'tenant_a/' });
    const b = new VectorStore(adapter, dim, 50, { collectionPrefix: 'tenant_b/' });

    seedRandom(a, 'docs', 5, dim);
    seedRandom(a, 'products', 3, dim);
    seedRandom(b, 'docs', 4, dim);
    a.flush(); b.flush();

    const dropped = await a.dropAll();
    assertEq(dropped.sort(), ['docs', 'products']);

    // Tenant A is empty
    const aCols = await a.listCollections();
    assertEq(aCols, []);

    // Tenant B intact
    const bCols = await b.listCollections();
    assertEq(bCols, ['docs']);
    assert(b.count('docs') === 4);
  });

  await test('listCollections handles unrelated keys gracefully', async () => {
    const adapter = new MemoryStorageAdapter();
    // Pollute adapter with unrelated keys
    adapter.writeJson('unrelated_config.json', { foo: 1 });
    adapter.writeBin('random.txt', new ArrayBuffer(8));

    const store = new VectorStore(adapter, dim, 50, { collectionPrefix: 'tenant_a/' });
    seedRandom(store, 'docs', 5, dim);
    store.flush();

    const cols = await store.listCollections();
    assertEq(cols, ['docs'], 'should ignore non-tenant keys');
  });

  // CloudflareKVAdapter integration
  await test('CloudflareKVAdapter.listKeys() works for VectorStore.listCollections', async () => {
    const kv = new MockKV();
    const adapter = new CloudflareKVAdapter(kv, 'glosa/');

    // Wait — VectorStore writes are sync but the adapter persist is async. We need
    // to call adapter.persist() after store.flush().
    const store = new VectorStore(adapter, dim, 50, { collectionPrefix: 'tenant_x/' });
    seedRandom(store, 'docs', 5, dim);
    seedRandom(store, 'orders', 3, dim);
    store.flush();
    await adapter.persist();

    // Re-open WITHOUT knowing collection names
    const a2 = new CloudflareKVAdapter(kv, 'glosa/');
    const store2 = new VectorStore(a2, dim, 50, { collectionPrefix: 'tenant_x/' });
    const cols = await store2.listCollections();
    assertEq(cols, ['docs', 'orders']);
  });

  await test('CloudflareKVAdapter prefix + VectorStore prefix compose correctly', async () => {
    const kv = new MockKV();
    // Adapter prefix: 'app/'  +  Store prefix: 'tenant_y/'  →  app/tenant_y/docs.bin
    const adapter = new CloudflareKVAdapter(kv, 'app/');
    const store = new VectorStore(adapter, dim, 50, { collectionPrefix: 'tenant_y/' });
    seedRandom(store, 'docs', 3, dim);
    store.flush();
    await adapter.persist();

    const rawKeys = [...kv._store.keys()];
    assert(rawKeys.includes('app/tenant_y/docs.json'), `expected composed prefix, got: ${rawKeys}`);
    assert(rawKeys.includes('app/tenant_y/docs.bin'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
