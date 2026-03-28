/**
 * Test de BinaryQuantizedStore + Distance Metrics + Score Normalization
 */

const {
  VectorStore,
  QuantizedStore,
  BinaryQuantizedStore,
  MemoryStorageAdapter,
  normalize,
  cosineSim,
  computeScore,
  manhattanDist,
} = require('./js-vector-store');

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN  = process.env.CF_API_TOKEN;
const MODEL      = '@cf/google/embeddinggemma-300m';
const API_URL    = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`;

async function getEmbeddings(texts) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: Array.isArray(texts) ? texts : [texts] }),
  });
  if (!res.ok) throw new Error(`Workers AI error ${res.status}: ${await res.text()}`);
  return (await res.json()).result.data;
}

const documents = [
  { id: 'ia-salud',       text: 'La inteligencia artificial esta revolucionando el diagnostico medico' },
  { id: 'ml-finanzas',    text: 'Machine learning aplicado a la deteccion de fraudes financieros' },
  { id: 'nlp-chatbots',   text: 'Procesamiento de lenguaje natural para chatbots empresariales' },
  { id: 'cv-autonomos',   text: 'Vision por computadora en vehiculos autonomos' },
  { id: 'db-vectoriales', text: 'Bases de datos vectoriales para busqueda semantica' },
  { id: 'cloud-infra',    text: 'Infraestructura cloud para despliegue de modelos de IA' },
  { id: 'robotica',       text: 'Robotica industrial y automatizacion con deep learning' },
  { id: 'rec-systems',    text: 'Sistemas de recomendacion basados en embeddings' },
  { id: 'gen-ai',         text: 'Modelos generativos de texto e imagenes con transformers' },
  { id: 'etica-ia',       text: 'Etica y sesgo en sistemas de inteligencia artificial' },
];

const queries = [
  'inteligencia artificial en medicina',
  'como detectar fraude con machine learning',
  'busqueda semantica con vectores',
  'etica en la inteligencia artificial',
];

let passed = 0, failed = 0;
function assert(label, condition) {
  if (condition) { passed++; }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

async function main() {
  console.log('=== Test BinaryQuantizedStore + Distance Metrics ===\n');

  // Generate embeddings
  console.log('Generando embeddings...');
  const docTexts = documents.map(d => d.text);
  const [docEmbs, queryEmbs] = await Promise.all([
    getEmbeddings(docTexts),
    getEmbeddings(queries),
  ]);
  const dim = docEmbs[0].length;
  console.log(`Dim: ${dim}\n`);

  // ─── 1. BinaryQuantizedStore basics ─────────────────────
  console.log('1. BINARY QUANTIZED STORE - BASICS\n');

  const b1 = new BinaryQuantizedStore(new MemoryStorageAdapter(), dim);

  for (let i = 0; i < documents.length; i++) {
    b1.set('docs', documents[i].id, docEmbs[i], { text: documents[i].text });
  }
  b1.flush();

  assert('count = 10', b1.count('docs') === 10);
  assert('has ia-salud', b1.has('docs', 'ia-salud'));
  assert('!has nonexistent', !b1.has('docs', 'nonexistent'));
  assert('ids length = 10', b1.ids('docs').length === 10);
  assert('bytesPerVector = ceil(768/8) = 96', b1.bytesPerVector() === 96);

  const got = b1.get('docs', 'ia-salud');
  assert('get returns object', got !== null);
  assert('get.vector is +1/-1', got.vector.every(v => v === 1.0 || v === -1.0));
  assert('get.vector.length = dim', got.vector.length === dim);

  console.log(`  Storage: ${b1.bytesPerVector()} bytes/vec (vs Float32: ${dim * 4} bytes = ${((dim * 4) / b1.bytesPerVector()).toFixed(0)}x compression)`);

  // ─── 2. Search quality ──────────────────────────────────
  console.log('\n2. SEARCH QUALITY - Binary vs Float32 vs Int8\n');

  const f32 = new VectorStore(new MemoryStorageAdapter(), dim);
  const q8  = new QuantizedStore(new MemoryStorageAdapter(), dim);
  for (let i = 0; i < documents.length; i++) {
    f32.set('docs', documents[i].id, docEmbs[i], { text: documents[i].text });
    q8.set('docs', documents[i].id, docEmbs[i], { text: documents[i].text });
  }
  f32.flush();
  q8.flush();

  let top1Match = 0;
  for (let q = 0; q < queries.length; q++) {
    const f32r = f32.search('docs', queryEmbs[q], 3);
    const b1r  = b1.search('docs', queryEmbs[q], 3);

    console.log(`  Query: "${queries[q]}"`);
    console.log(`    F32: [${f32r[0].score.toFixed(4)}] ${f32r[0].id}`);
    console.log(`    B1:  [${b1r[0].score.toFixed(4)}] ${b1r[0].id}`);
    if (f32r[0].id === b1r[0].id) top1Match++;
  }
  console.log(`\n  Top-1 match rate: ${top1Match}/${queries.length}`);
  assert('top-1 match >= 3/4', top1Match >= 3);

  // ─── 3. Distance metrics ───────────────────────────────
  console.log('\n3. DISTANCE METRICS\n');

  const metrics = ['cosine', 'euclidean', 'dotProduct', 'manhattan'];
  for (const metric of metrics) {
    const results = f32.search('docs', queryEmbs[0], 3, 0, metric);
    console.log(`  ${metric.padEnd(12)} → top-1: [${results[0].score.toFixed(4)}] ${results[0].id}`);
    assert(`${metric} returns results`, results.length === 3);
    assert(`${metric} has scores`, results[0].score > 0);
  }

  // Verify manhattanDist
  const a = [1, 0, -1, 2], b = [0, 1, 0, -1];
  assert('manhattanDist([1,0,-1,2],[0,1,0,-1]) = 6', manhattanDist(a, b) === 6);

  // Verify computeScore
  assert('computeScore cosine = cosineSim', computeScore(a, b, 4, 'cosine') === cosineSim(a, b, 4));

  // ─── 4. Matryoshka on Binary ───────────────────────────
  console.log('\n4. MATRYOSHKA SEARCH (Binary)\n');

  const matResults = b1.matryoshkaSearch('docs', queryEmbs[0], 3, [128, 384, 768]);
  console.log(`  Query: "${queries[0]}"`);
  matResults.forEach((r, i) => console.log(`    ${i + 1}. [${r.score.toFixed(4)}] ${r.id}`));
  assert('matryoshka returns results', matResults.length === 3);
  assert('matryoshka top-1 matches brute-force', matResults[0].id === b1.search('docs', queryEmbs[0], 1)[0].id);

  // ─── 5. Remove (swap-with-last) ────────────────────────
  console.log('\n5. REMOVE (swap-with-last)\n');

  const b1copy = new BinaryQuantizedStore(new MemoryStorageAdapter(), dim);
  for (let i = 0; i < documents.length; i++) {
    b1copy.set('docs', documents[i].id, docEmbs[i], { text: documents[i].text });
  }
  b1copy.flush();

  assert('remove returns true', b1copy.remove('docs', 'ia-salud'));
  assert('count after remove = 9', b1copy.count('docs') === 9);
  assert('removed id not found', !b1copy.has('docs', 'ia-salud'));
  assert('remove nonexistent returns false', !b1copy.remove('docs', 'ia-salud'));

  // Verify remaining docs still searchable
  const postRemove = b1copy.search('docs', queryEmbs[1], 3);
  assert('search after remove works', postRemove.length === 3);
  assert('removed id not in results', postRemove.every(r => r.id !== 'ia-salud'));

  // ─── 6. Score normalization in searchAcross ─────────────
  console.log('\n6. SCORE NORMALIZATION (searchAcross)\n');

  const ms = new VectorStore(new MemoryStorageAdapter(), dim);
  // Split docs into two collections with different score distributions
  for (let i = 0; i < 5; i++) {
    ms.set('tech', documents[i].id, docEmbs[i], { text: documents[i].text });
  }
  for (let i = 5; i < 10; i++) {
    ms.set('other', documents[i].id, docEmbs[i], { text: documents[i].text });
  }
  ms.flush();

  const crossResults = ms.searchAcross(['tech', 'other'], queryEmbs[0], 5);
  console.log(`  Cross-collection search (normalized):`);
  crossResults.forEach((r, i) =>
    console.log(`    ${i + 1}. [${r.score.toFixed(4)}] ${r.id}`)
  );
  assert('searchAcross returns results', crossResults.length === 5);
  assert('scores are normalized [0,1]', crossResults.every(r => r.score >= 0 && r.score <= 1.001));

  // ─── 7. Import/Export Binary ────────────────────────────
  console.log('\n7. IMPORT/EXPORT\n');

  const exported = b1.export('docs');
  assert('export length = 10', exported.length === 10);
  assert('export has +1/-1 vectors', exported[0].vector.every(v => v === 1.0 || v === -1.0));

  const b1import = new BinaryQuantizedStore(new MemoryStorageAdapter(), dim);
  const count = b1import.import('docs', exported);
  assert('import count = 10', count === 10);

  const importSearch = b1import.search('docs', queryEmbs[0], 3);
  const origSearch   = b1.search('docs', queryEmbs[0], 3);
  assert('import search matches original', importSearch[0].id === origSearch[0].id);

  // ─── Summary ───────────────────────────────────────────
  console.log(`\n${'='.repeat(50)}`);
  console.log(`PASSED: ${passed}  FAILED: ${failed}`);
  if (failed > 0) process.exit(1);
  console.log('');
}

main().catch(console.error);
