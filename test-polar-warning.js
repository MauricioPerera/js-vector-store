// Test for PolarQuantizedStore.matryoshkaSearch warning + silent option (issue #2)
// Run: node test-polar-warning.js

const { PolarQuantizedStore, MemoryStorageAdapter } = require('./js-vector-store');

let passed = 0, failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

// Helper: capture console.warn calls
const captureWarn = (fn) => {
  const orig = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args.join(' '));
  try { fn(); } finally { console.warn = orig; }
  return calls;
};

const seedStore = (store, dim, n = 20) => {
  for (let i = 0; i < n; i++) {
    const v = new Array(dim).fill(0).map(() => Math.random() - 0.5);
    store.set('items', `id_${i}`, v, { i });
  }
  store.flush();
};

(async () => {
  console.log('PolarQuantizedStore matryoshka warning tests\n');
  const dim = 64;
  const query = new Array(dim).fill(0).map(() => Math.random() - 0.5);

  test('warns once on first matryoshkaSearch call', () => {
    const store = new PolarQuantizedStore(new MemoryStorageAdapter(), dim);
    seedStore(store, dim);
    const calls = captureWarn(() => {
      store.matryoshkaSearch('items', query, 5, [16, 32, 64]);
    });
    assert(calls.length === 1, `expected 1 warn, got ${calls.length}`);
    assert(calls[0].includes('dequantizes'), `unexpected message: ${calls[0]}`);
  });

  test('warning is deduplicated across multiple calls on same instance', () => {
    const store = new PolarQuantizedStore(new MemoryStorageAdapter(), dim);
    seedStore(store, dim);
    const calls = captureWarn(() => {
      store.matryoshkaSearch('items', query, 5, [16, 32, 64]);
      store.matryoshkaSearch('items', query, 5, [16, 32, 64]);
      store.matryoshkaSearch('items', query, 5, [16, 32, 64]);
    });
    assert(calls.length === 1, `expected 1 warn (dedup), got ${calls.length}`);
  });

  test('silent: true suppresses the warning', () => {
    const store = new PolarQuantizedStore(new MemoryStorageAdapter(), dim, { silent: true });
    seedStore(store, dim);
    const calls = captureWarn(() => {
      store.matryoshkaSearch('items', query, 5, [16, 32, 64]);
    });
    assert(calls.length === 0, `expected 0 warns with silent:true, got ${calls.length}`);
  });

  test('search() (flat) does not warn', () => {
    const store = new PolarQuantizedStore(new MemoryStorageAdapter(), dim);
    seedStore(store, dim);
    const calls = captureWarn(() => {
      store.search('items', query, 5);
    });
    assert(calls.length === 0, `flat search should not warn, got ${calls.length}`);
  });

  test('matryoshkaSearch still returns valid results despite warning', () => {
    const store = new PolarQuantizedStore(new MemoryStorageAdapter(), dim, { silent: true });
    seedStore(store, dim);
    const results = store.matryoshkaSearch('items', query, 5, [16, 32, 64]);
    assert(results.length === 5, `expected 5 results, got ${results.length}`);
    assert(results.every(r => r.id && typeof r.score === 'number'), 'malformed results');
    // Scores should be sorted descending
    for (let i = 1; i < results.length; i++) {
      assert(results[i - 1].score >= results[i].score, 'results not sorted by score');
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
