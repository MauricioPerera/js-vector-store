/**
 * Test del Reranker con Workers AI bge-reranker-base
 */

const {
  VectorStore,
  BinaryQuantizedStore,
  MemoryStorageAdapter,
  Reranker,
  normalize,
} = require('./js-vector-store');

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
const CF_TOKEN   = process.env.CF_API_TOKEN;

async function embed(texts, model) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${model}`,
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
  'La inteligencia artificial esta revolucionando el diagnostico medico',
  'Machine learning aplicado a la deteccion de fraudes financieros',
  'Procesamiento de lenguaje natural para chatbots empresariales',
  'Vision por computadora en vehiculos autonomos',
  'Bases de datos vectoriales para busqueda semantica',
  'Robotica industrial y automatizacion con deep learning',
];

async function main() {
  console.log('=== Test Reranker + Cross-Model Search ===\n');

  // ─── 1. Reranker standalone ──────────────────────────
  console.log('1. RERANKER STANDALONE (bge-reranker-base)\n');

  const reranker = Reranker.cloudflare(CF_ACCOUNT, CF_TOKEN);

  const query = 'inteligencia artificial en medicina';
  const ranked = await reranker.rank(query, documents);

  console.log(`  Query: "${query}"`);
  for (const r of ranked) {
    console.log(`    [${r.score.toFixed(4)}] #${r.index} — ${documents[r.index].slice(0, 60)}`);
  }

  console.log(`\n  Top result: "${documents[ranked[0].index].slice(0, 60)}"`);
  const topIsIA = documents[ranked[0].index].includes('inteligencia artificial');
  console.log(`  Correct: ${topIsIA ? 'YES' : 'NO'}\n`);

  // ─── 2. Cross-model search ───────────────────────────
  console.log('2. CROSS-MODEL SEARCH (2 modelos distintos)\n');

  // Embeddear docs 0-2 con EmbeddingGemma (768d)
  console.log('  Embedding docs 0-2 con EmbeddingGemma (768d)...');
  const gemmaEmbs = await embed(
    documents.slice(0, 3),
    '@cf/google/embeddinggemma-300m'
  );
  const gemmaDim = gemmaEmbs[0].length;

  // Embeddear docs 3-5 con bge-base-en (768d)
  console.log('  Embedding docs 3-5 con bge-base-en-v1.5 (768d)...');
  const bgeEmbs = await embed(
    documents.slice(3, 6),
    '@cf/baai/bge-base-en-v1.5'
  );
  const bgeDim = bgeEmbs[0].length;

  console.log(`  Gemma dim: ${gemmaDim}, BGE dim: ${bgeDim}\n`);

  // Crear 2 stores con modelos distintos
  const storeA = new BinaryQuantizedStore(new MemoryStorageAdapter(), gemmaDim);
  const storeB = new BinaryQuantizedStore(new MemoryStorageAdapter(), bgeDim);

  for (let i = 0; i < 3; i++) {
    storeA.set('gemma', `doc-${i}`, gemmaEmbs[i], { text: documents[i] });
  }
  for (let i = 0; i < 3; i++) {
    storeB.set('bge', `doc-${i + 3}`, bgeEmbs[i], { text: documents[i + 3] });
  }
  storeA.flush();
  storeB.flush();

  // Query embeddings (uno por modelo)
  const queryText = 'diagnostico medico con inteligencia artificial';
  console.log(`  Query: "${queryText}"`);

  const [qGemma] = await embed([queryText], '@cf/google/embeddinggemma-300m');
  const [qBge]   = await embed([queryText], '@cf/baai/bge-base-en-v1.5');

  // Busqueda sin reranker (cada store por separado)
  console.log('\n  Sin reranker (cada store por separado):');
  const resA = storeA.search('gemma', qGemma, 3);
  const resB = storeB.search('bge', qBge, 3);
  console.log('    Store A (Gemma):');
  resA.forEach(r => console.log(`      [${r.score.toFixed(4)}] ${r.id} — ${r.metadata.text.slice(0, 50)}`));
  console.log('    Store B (BGE):');
  resB.forEach(r => console.log(`      [${r.score.toFixed(4)}] ${r.id} — ${r.metadata.text.slice(0, 50)}`));

  // Busqueda con reranker (cross-model)
  console.log('\n  Con reranker (cross-model, unificado):');
  const crossResults = await reranker.crossModelSearch(queryText, [
    { store: storeA, collection: 'gemma', queryVector: qGemma },
    { store: storeB, collection: 'bge',   queryVector: qBge },
  ], { limit: 5, textField: 'text' });

  for (const r of crossResults) {
    console.log(`    [${r.score.toFixed(4)}] ${r.id} (${r.collection}) — ${r.metadata.text.slice(0, 50)}`);
  }

  const topCorrect = crossResults[0].metadata.text.includes('inteligencia artificial');
  console.log(`\n  Top result correct: ${topCorrect ? 'YES' : 'NO'}`);

  console.log('\nDone.');
}

main().catch(console.error);
