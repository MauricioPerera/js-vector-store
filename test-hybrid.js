/**
 * Test de BM25 + HybridSearch
 */

const {
  VectorStore,
  BM25Index,
  HybridSearch,
  SimpleTokenizer,
  MemoryStorageAdapter,
} = require('./js-vector-store');

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
const CF_TOKEN   = process.env.CF_API_TOKEN;

async function embed(texts) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/google/embeddinggemma-300m`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: texts }),
    }
  );
  if (!res.ok) throw new Error(`Embed error: ${res.status}`);
  return (await res.json()).result.data;
}

const documents = [
  { id: 'doc-1', text: 'La inteligencia artificial esta revolucionando el diagnostico medico en hospitales' },
  { id: 'doc-2', text: 'Machine learning aplicado a la deteccion de fraudes en transacciones financieras' },
  { id: 'doc-3', text: 'Procesamiento de lenguaje natural para asistentes virtuales y chatbots' },
  { id: 'doc-4', text: 'Vision por computadora en vehiculos autonomos y sistemas de navegacion' },
  { id: 'doc-5', text: 'Bases de datos vectoriales para busqueda semantica a gran escala' },
  { id: 'doc-6', text: 'Robotica industrial y automatizacion de lineas de produccion con deep learning' },
  { id: 'doc-7', text: 'Sistemas de recomendacion personalizados basados en embeddings de usuarios' },
  { id: 'doc-8', text: 'Etica y sesgo algoritmico en sistemas de inteligencia artificial' },
];

let passed = 0, failed = 0;
function assert(label, cond) {
  if (cond) { passed++; }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

async function main() {
  console.log('=== Test BM25 + HybridSearch ===\n');

  // ─── 1. BM25 standalone ────────────────────────────────
  console.log('1. BM25 INDEX\n');

  const bm25 = new BM25Index();

  for (const doc of documents) {
    bm25.addDocument('docs', doc.id, doc.text);
  }

  assert('count = 8', bm25.count('docs') === 8);
  assert('vocabulary > 0', bm25.vocabularySize('docs') > 0);
  console.log(`  Docs: ${bm25.count('docs')}, Vocabulary: ${bm25.vocabularySize('docs')} terms\n`);

  // Search BM25
  const queries = [
    'inteligencia artificial medicina',
    'fraude financiero machine learning',
    'busqueda semantica vectores',
    'etica inteligencia artificial',
  ];

  for (const q of queries) {
    const results = bm25.search('docs', q, 3);
    console.log(`  Query: "${q}"`);
    results.forEach(r => console.log(`    [${r.score.toFixed(4)}] ${r.id}`));
    assert(`BM25 "${q}" returns results`, results.length > 0);
  }

  // ─── 2. Tokenizer ─────────────────────────────────────
  console.log('\n2. TOKENIZER\n');

  const tok = new SimpleTokenizer();
  const tokens = tok.tokenize('La inteligencia artificial EN medicina!!! es INCREÍBLE');
  console.log(`  Input: "La inteligencia artificial EN medicina!!! es INCREÍBLE"`);
  console.log(`  Tokens: [${tokens.join(', ')}]`);
  assert('filters stop words', !tokens.includes('la') && !tokens.includes('en') && !tokens.includes('es'));
  assert('lowercases', tokens.includes('inteligencia'));
  assert('keeps content words', tokens.includes('medicina'));

  // ─── 3. BM25 persistence ──────────────────────────────
  console.log('\n3. BM25 PERSISTENCE\n');

  const adapter = new MemoryStorageAdapter();
  bm25.save(adapter, 'docs');

  const bm25b = new BM25Index();
  bm25b.load(adapter, 'docs');
  assert('loaded count matches', bm25b.count('docs') === 8);

  const origResults = bm25.search('docs', 'inteligencia artificial', 3);
  const loadResults = bm25b.search('docs', 'inteligencia artificial', 3);
  assert('loaded search matches', origResults[0].id === loadResults[0].id);
  assert('loaded scores match', Math.abs(origResults[0].score - loadResults[0].score) < 0.001);

  // ─── 4. Remove document ───────────────────────────────
  console.log('\n4. REMOVE DOCUMENT\n');

  bm25.removeDocument('docs', 'doc-1');
  assert('count after remove = 7', bm25.count('docs') === 7);
  const afterRemove = bm25.search('docs', 'inteligencia artificial medicina', 3);
  assert('removed doc not in results', afterRemove.every(r => r.id !== 'doc-1'));

  // Re-add for hybrid test
  bm25.addDocument('docs', 'doc-1', documents[0].text);

  // ─── 5. Hybrid search (RRF) ───────────────────────────
  console.log('\n5. HYBRID SEARCH (RRF)\n');

  console.log('  Generating embeddings...');
  const embs = await embed(documents.map(d => d.text));
  const dim = embs[0].length;

  const store = new VectorStore(new MemoryStorageAdapter(), dim);
  for (let i = 0; i < documents.length; i++) {
    store.set('docs', documents[i].id, embs[i], { text: documents[i].text });
  }
  store.flush();

  const hybrid = new HybridSearch(store, bm25, 'rrf');

  const [qVec] = await embed(['inteligencia artificial diagnostico medico']);

  console.log('  Query: "inteligencia artificial diagnostico medico"\n');

  // Vector only
  const vecResults = store.search('docs', qVec, 5);
  console.log('  Vector only:');
  vecResults.forEach(r => console.log(`    [${r.score.toFixed(4)}] ${r.id}`));

  // BM25 only
  const bm25Results = bm25.search('docs', 'inteligencia artificial diagnostico medico', 5);
  console.log('  BM25 only:');
  bm25Results.forEach(r => console.log(`    [${r.score.toFixed(4)}] ${r.id}`));

  // Hybrid RRF
  const rrfResults = hybrid.search('docs', qVec, 'inteligencia artificial diagnostico medico', 5);
  console.log('  Hybrid RRF:');
  rrfResults.forEach(r => console.log(`    [${r.score.toFixed(6)}] ${r.id}`));

  assert('RRF returns results', rrfResults.length === 5);
  assert('RRF top-1 is IA doc', rrfResults[0].id === 'doc-1');

  // ─── 6. Hybrid search (Weighted) ──────────────────────
  console.log('\n6. HYBRID SEARCH (Weighted)\n');

  const hybridW = new HybridSearch(store, bm25, 'weighted');
  const wResults = hybridW.search('docs', qVec, 'inteligencia artificial diagnostico medico', 5, {
    vectorWeight: 0.7,
    textWeight: 0.3,
  });
  console.log('  Hybrid Weighted (0.7 vec + 0.3 text):');
  wResults.forEach(r => console.log(`    [${r.score.toFixed(6)}] ${r.id}`));

  assert('Weighted returns results', wResults.length === 5);
  assert('Weighted top-1 is IA doc', wResults[0].id === 'doc-1');

  // ─── 7. Cross-collection hybrid ───────────────────────
  console.log('\n7. CROSS-COLLECTION HYBRID\n');

  // Split into 2 collections
  const store2 = new VectorStore(new MemoryStorageAdapter(), dim);
  const bm25_2 = new BM25Index();

  for (let i = 0; i < 4; i++) {
    store2.set('tech', documents[i].id, embs[i], { text: documents[i].text });
    bm25_2.addDocument('tech', documents[i].id, documents[i].text);
  }
  for (let i = 4; i < 8; i++) {
    store2.set('other', documents[i].id, embs[i], { text: documents[i].text });
    bm25_2.addDocument('other', documents[i].id, documents[i].text);
  }
  store2.flush();

  const hybrid2 = new HybridSearch(store2, bm25_2, 'rrf');
  const crossResults = hybrid2.searchAcross(['tech', 'other'], qVec, 'inteligencia artificial diagnostico medico', 5);
  console.log('  Cross-collection RRF:');
  crossResults.forEach(r => console.log(`    [${r.score.toFixed(6)}] ${r.id} (${r.collection})`));

  assert('cross-collection returns results', crossResults.length === 5);

  // ─── Summary ──────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`PASSED: ${passed}  FAILED: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(console.error);
