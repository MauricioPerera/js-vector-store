/**
 * Ejemplo de uso de js-vector-store
 * Equivalente al Quick Start del php-vector-store
 */

const {
  VectorStore,
  QuantizedStore,
  IVFIndex,
  MemoryStorageAdapter,
  normalize,
} = require('./js-vector-store');

// Helper: genera un vector aleatorio de dimensión N (simulando un embedding)
function fakeEmbedding(dim = 384) {
  return normalize(Array.from({ length: dim }, () => Math.random() * 2 - 1));
}

// ───────────────────────────────────────────────
// DEMO 1: VectorStore (Float32)
// ───────────────────────────────────────────────
console.log('\n=== VectorStore (Float32, 384d) ===');

const store = new VectorStore(
  new MemoryStorageAdapter(), // ← en disco: new VectorStore('./vectors', 384)
  384
);

// Indexar documentos
const docs = [
  { id: 'doc-1', text: 'Inteligencia artificial en salud',    tags: ['ia', 'salud'] },
  { id: 'doc-2', text: 'Machine learning para finanzas',       tags: ['ml', 'finanzas'] },
  { id: 'doc-3', text: 'Redes neuronales convolucionales',     tags: ['ia', 'cv'] },
  { id: 'doc-4', text: 'NLP y procesamiento de texto',         tags: ['ia', 'nlp'] },
  { id: 'doc-5', text: 'Bases de datos vectoriales en la nube',tags: ['db', 'cloud'] },
];

for (const doc of docs) {
  store.set('articles', doc.id, fakeEmbedding(384), { text: doc.text, tags: doc.tags });
}
store.flush();

console.log(`Colección 'articles': ${store.count('articles')} vectores`);

// Búsqueda brute-force
const query = fakeEmbedding(384);
const results = store.search('articles', query, 3);
console.log('\nBúsqueda brute-force (top 3):');
results.forEach(r => console.log(`  [${r.score.toFixed(4)}] ${r.id} — ${r.metadata.text}`));

// Búsqueda Matryoshka
const mResults = store.matryoshkaSearch('articles', query, 3, [128, 256, 384]);
console.log('\nBúsqueda Matryoshka (top 3):');
mResults.forEach(r => console.log(`  [${r.score.toFixed(4)}] ${r.id} — ${r.metadata.text}`));

// ───────────────────────────────────────────────
// DEMO 2: QuantizedStore (Int8)
// ───────────────────────────────────────────────
console.log('\n=== QuantizedStore (Int8, 384d) ===');

const q8 = new QuantizedStore(new MemoryStorageAdapter(), 384);

for (const doc of docs) {
  q8.set('articles', doc.id, fakeEmbedding(384), { text: doc.text });
}
q8.flush();

const q8Results = q8.matryoshkaSearch('articles', query, 3, [128, 256, 384]);
console.log('\nBúsqueda Matryoshka quantizada (top 3):');
q8Results.forEach(r => console.log(`  [${r.score.toFixed(4)}] ${r.id} — ${r.metadata.text}`));

console.log(`\nStorage por vector:`);
console.log(`  Float32 384d: ${384 * 4} bytes`);
console.log(`  Int8    384d: ${384 + 8} bytes (${((384 + 8) / (384 * 4) * 100).toFixed(0)}% del tamaño original)`);

// ───────────────────────────────────────────────
// DEMO 3: IVF Index (escala grande)
// ───────────────────────────────────────────────
console.log('\n=== IVF Index (simulando dataset grande) ===');

const bigStore = new QuantizedStore(new MemoryStorageAdapter(), 128);

// Insertar 1000 vectores
for (let i = 0; i < 1000; i++) {
  bigStore.set('corpus', `item-${i}`, fakeEmbedding(128), { idx: i });
}
bigStore.flush();

const ivf = new IVFIndex(bigStore, /* numClusters */ 20, /* numProbes */ 4);
const stats = ivf.build('corpus');
console.log(`IVF construido: ${stats.numClusters} clusters, ${stats.numVectors} vectores`);

const q128 = fakeEmbedding(128);
const ivfResults = ivf.matryoshkaSearch('corpus', q128, 5, [32, 64, 128]);
console.log('\nIVF + Matryoshka (top 5):');
ivfResults.forEach(r => console.log(`  [${r.score.toFixed(4)}] ${r.id}`));

// ───────────────────────────────────────────────
// DEMO 4: Multi-colección
// ───────────────────────────────────────────────
console.log('\n=== Multi-colección ===');

const ms = new VectorStore(new MemoryStorageAdapter(), 128);

ms.set('posts',    'p-1', fakeEmbedding(128), { title: 'Post sobre IA' });
ms.set('users',    'u-1', fakeEmbedding(128), { name: 'Mauricio' });
ms.set('products', 'pr-1',fakeEmbedding(128), { name: 'Producto A' });
ms.flush();

const crossResults = ms.searchAcross(['posts', 'users', 'products'], fakeEmbedding(128), 5);
console.log('\nsearchAcross (top 5 globales):');
crossResults.forEach(r => console.log(`  [${r.score.toFixed(4)}] ${r.id} — ${JSON.stringify(r.metadata)}`));

console.log('\n✅ Done');
