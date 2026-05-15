/**
 * Pruebas para los fixes de la sesión actual.
 * #8  CloudflareKVAdapter: dirty tracking en persist()
 * #9  CloudflareKVAdapter: delete() elimina de KV
 * #10 VectorStore: maxCollections enforcement
 * #11 FileStorageAdapter: listKeys()
 * #12 VectorStore.remove(): no writeBin directo
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const {
  VectorStore,
  QuantizedStore,
  BinaryQuantizedStore,
  PolarQuantizedStore,
  FileStorageAdapter,
  MemoryStorageAdapter,
  CloudflareKVAdapter,
  normalize,
} = require('./js-vector-store');

let passed = 0, failed = 0;

function assert(label, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  OK: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}${extra ? ' — ' + extra : ''}`);
  }
}

function fakeVec(dim = 8) {
  return normalize(Array.from({ length: dim }, (_, i) => Math.sin(i + 1)));
}

async function main() {

// ────────────────────────────────────────────────────────────
// #11 — FileStorageAdapter.listKeys()
// ────────────────────────────────────────────────────────────
console.log('\n#11 — FileStorageAdapter.listKeys()\n');

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-test-'));
  try {
    const adapter = new FileStorageAdapter(tmpDir);
    assert('listKeys() en dir vacío devuelve array', Array.isArray(adapter.listKeys()));
    assert('listKeys() en dir vacío devuelve []', adapter.listKeys().length === 0);

    adapter.writeBin('col1.bin', new ArrayBuffer(4));
    adapter.writeJson('col1.json', { ids: [] });
    adapter.writeBin('col2.bin', new ArrayBuffer(4));

    const keys = adapter.listKeys();
    assert('listKeys() detecta 3 archivos', keys.length === 3);
    assert('listKeys() incluye col1.bin', keys.includes('col1.bin'));
    assert('listKeys() incluye col1.json', keys.includes('col1.json'));
    assert('listKeys() incluye col2.bin', keys.includes('col2.bin'));

    // VectorStore usa listKeys() via listCollections()
    const store = new VectorStore(new FileStorageAdapter(tmpDir), 4);
    const v = fakeVec(4);
    store.set('myCol', 'v1', v, {});
    store.flush();

    const store2 = new VectorStore(new FileStorageAdapter(tmpDir), 4);
    const cols = await store2.listCollections();
    assert('listCollections() descubre colección en disco', cols.includes('myCol'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
}

// ────────────────────────────────────────────────────────────
// #10 — VectorStore.maxCollections enforcement
// ────────────────────────────────────────────────────────────
console.log('\n#10 — VectorStore.maxCollections enforcement\n');

{
  const store = new VectorStore(new MemoryStorageAdapter(), 4, 2);
  const v = fakeVec(4);
  store.set('col1', 'v1', v, {});
  store.set('col2', 'v2', v, {});
  assert('primeras 2 colecciones se crean sin error', true);

  let threw = false;
  try {
    store.set('col3', 'v3', v, {});
  } catch (e) {
    threw = e.message.includes('maxCollections');
  }
  assert('3ª colección lanza error con mensaje maxCollections', threw);

  // maxCollections=0 significa sin límite
  const unlimited = new VectorStore(new MemoryStorageAdapter(), 4, 0);
  for (let i = 0; i < 10; i++) unlimited.set(`c${i}`, 'v1', v, {});
  assert('maxCollections=0 no limita', unlimited._collections.size === 10);
}

// ────────────────────────────────────────────────────────────
// #12 — VectorStore.remove() no llama writeBin directamente
// ────────────────────────────────────────────────────────────
console.log('\n#12 — VectorStore.remove() defers to flush()\n');

function testRemoveDefer(StoreClass, dim, label) {
  let writeBinCalls = 0;
  const inner = new MemoryStorageAdapter();
  const originalWriteBin = inner.writeBin.bind(inner);
  inner.writeBin = (k, v) => { writeBinCalls++; originalWriteBin(k, v); };

  const store = new StoreClass(inner, dim);
  const v = fakeVec(dim);
  store.set('col', 'id1', v, {});
  store.set('col', 'id2', v, {});
  store.flush();
  const callsBeforeRemove = writeBinCalls;

  store.remove('col', 'id1');
  assert(
    `${label}: remove() no llama writeBin directamente`,
    writeBinCalls === callsBeforeRemove
  );

  store.flush();
  assert(
    `${label}: flush() después de remove() llama writeBin`,
    writeBinCalls > callsBeforeRemove
  );

  assert(
    `${label}: id1 eliminado del store en memoria`,
    !store.has('col', 'id1')
  );
  assert(
    `${label}: id2 sigue en el store`,
    store.has('col', 'id2')
  );
}

testRemoveDefer(VectorStore, 8, 'VectorStore(Float32)');
testRemoveDefer(QuantizedStore, 8, 'QuantizedStore(Int8)');
testRemoveDefer(BinaryQuantizedStore, 8, 'BinaryQuantizedStore');
testRemoveDefer(PolarQuantizedStore, 8, 'PolarQuantizedStore');

// ────────────────────────────────────────────────────────────
// #8 — CloudflareKVAdapter: dirty tracking en persist()
// ────────────────────────────────────────────────────────────
console.log('\n#8 — CloudflareKVAdapter dirty tracking\n');

{
  const puts = [];
  const deletes = [];
  const mockKV = {
    async get(key, type) { return null; },
    async put(key, val) { puts.push(key); },
    async delete(key)   { deletes.push(key); },
    async list({ prefix, cursor } = {}) { return { keys: [], list_complete: true }; },
  };

  const adapter = new CloudflareKVAdapter(mockKV, 'vs/');
  adapter.writeBin('a.bin', new ArrayBuffer(4));
  adapter.writeJson('a.json', { ids: [] });
  adapter.writeJson('b.json', { ids: [] });

  await adapter.persist();
  assert('persist() solo escribe 3 keys (las dirty)', puts.length === 3);
  assert('a.bin se escribió', puts.includes('vs/a.bin'));
  assert('a.json se escribió', puts.includes('vs/a.json'));
  assert('b.json se escribió', puts.includes('vs/b.json'));

  // Segunda llamada: sin cambios → no escribe nada
  puts.length = 0;
  await adapter.persist();
  assert('persist() sin cambios no escribe nada', puts.length === 0);

  // Modificar solo una key
  adapter.writeJson('a.json', { ids: ['x'] });
  await adapter.persist();
  assert('persist() solo escribe la key modificada', puts.length === 1 && puts[0] === 'vs/a.json');
}

// ────────────────────────────────────────────────────────────
// #9 — CloudflareKVAdapter: delete() elimina de KV en persist()
// ────────────────────────────────────────────────────────────
console.log('\n#9 — CloudflareKVAdapter delete removes from KV\n');

{
  const puts = [];
  const deletes = [];
  const mockKV = {
    async get()    { return null; },
    async put(k)   { puts.push(k); },
    async delete(k){ deletes.push(k); },
    async list()   { return { keys: [], list_complete: true }; },
  };

  const adapter = new CloudflareKVAdapter(mockKV, 'vs/');
  adapter.writeJson('col.json', { ids: ['a'] });
  await adapter.persist();
  puts.length = 0;

  adapter.delete('col.json');
  await adapter.persist();
  assert('persist() después de delete() llama kv.delete()', deletes.includes('vs/col.json'));
  assert('persist() no vuelve a escribir la key eliminada', !puts.includes('vs/col.json'));

  // Idempotente: segunda llamada sin más cambios
  deletes.length = 0;
  await adapter.persist();
  assert('persist() idempotente después de delete()', deletes.length === 0);
}

// ────────────────────────────────────────────────────────────
console.log(`\nResultado: ${passed} OK, ${failed} FAIL`);
if (failed > 0) process.exit(1);

} // end main

main().catch(err => { console.error(err); process.exit(1); });
