/**
 * Test de js-vector-store con EmbeddingGemma (Workers AI)
 */

const {
  VectorStore,
  QuantizedStore,
  IVFIndex,
  MemoryStorageAdapter,
  normalize,
  cosineSim,
} = require('./js-vector-store');

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN  = process.env.CF_API_TOKEN;
const MODEL      = '@cf/google/embeddinggemma-300m';

const API_URL = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`;

// ── Embedding via Workers AI ───────────────────────────────

async function getEmbeddings(texts) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ text: Array.isArray(texts) ? texts : [texts] }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Workers AI error ${res.status}: ${err}`);
  }

  const json = await res.json();
  return json.result.data; // array of float arrays
}

// ── Corpus de prueba ───────────────────────────────────────

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

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log('=== Test js-vector-store + EmbeddingGemma (Workers AI) ===\n');

  // 1. Generar embeddings de documentos
  console.log(`Generando embeddings para ${documents.length} documentos...`);
  const docTexts = documents.map(d => d.text);
  const docEmbeddings = await getEmbeddings(docTexts);

  const dim = docEmbeddings[0].length;
  console.log(`Dimension de embeddings: ${dim}\n`);

  // 2. Crear stores
  const f32Store = new VectorStore(new MemoryStorageAdapter(), dim);
  const q8Store  = new QuantizedStore(new MemoryStorageAdapter(), dim);

  // 3. Indexar en ambos stores
  for (let i = 0; i < documents.length; i++) {
    const doc = documents[i];
    const vec = docEmbeddings[i];
    f32Store.set('docs', doc.id, vec, { text: doc.text });
    q8Store.set('docs',  doc.id, vec, { text: doc.text });
  }
  f32Store.flush();
  q8Store.flush();

  console.log(`Indexados: ${f32Store.count('docs')} docs en Float32 y QuantizedInt8`);
  console.log(`Storage por vector: Float32=${dim * 4} bytes, Int8=${dim + 8} bytes\n`);

  // 4. Generar embeddings de queries
  console.log('Generando embeddings de queries...\n');
  const queryEmbeddings = await getEmbeddings(queries);

  // 5. Buscar en Float32
  console.log('─── Resultados Float32 (brute-force cosine) ───');
  for (let q = 0; q < queries.length; q++) {
    console.log(`\nQuery: "${queries[q]}"`);
    const results = f32Store.search('docs', queryEmbeddings[q], 3);
    results.forEach((r, i) =>
      console.log(`  ${i + 1}. [${r.score.toFixed(4)}] ${r.id} — ${r.metadata.text}`)
    );
  }

  // 6. Buscar en QuantizedInt8
  console.log('\n─── Resultados Int8 Quantized ───');
  for (let q = 0; q < queries.length; q++) {
    console.log(`\nQuery: "${queries[q]}"`);
    const results = q8Store.search('docs', queryEmbeddings[q], 3);
    results.forEach((r, i) =>
      console.log(`  ${i + 1}. [${r.score.toFixed(4)}] ${r.id} — ${r.metadata.text}`)
    );
  }

  // 7. Comparar precision Float32 vs Int8
  console.log('\n─── Comparacion de precision Float32 vs Int8 ───');
  for (let q = 0; q < queries.length; q++) {
    const f32Results = f32Store.search('docs', queryEmbeddings[q], 5);
    const q8Results  = q8Store.search('docs', queryEmbeddings[q], 5);

    const f32Order = f32Results.map(r => r.id);
    const q8Order  = q8Results.map(r => r.id);
    const match    = f32Order.every((id, i) => id === q8Order[i]);

    console.log(`Query ${q + 1}: orden ${match ? 'IDENTICO' : 'DIFERENTE'} (top-5)`);
    if (!match) {
      console.log(`  F32: ${f32Order.join(', ')}`);
      console.log(`  Q8:  ${q8Order.join(', ')}`);
    }
  }

  // 8. IVF Index (sobre QuantizedStore)
  console.log('\n─── IVF Index ───');
  const ivf = new IVFIndex(q8Store, /* clusters */ 3, /* probes */ 2);
  const stats = ivf.build('docs');
  console.log(`IVF: ${stats.numClusters} clusters, ${stats.numVectors} vectores`);

  console.log(`\nIVF search (query: "${queries[0]}"):`);
  const ivfResults = ivf.search('docs', queryEmbeddings[0], 3);
  ivfResults.forEach((r, i) =>
    console.log(`  ${i + 1}. [${r.score.toFixed(4)}] ${r.id} — ${r.metadata.text}`)
  );

  // 9. Cross-similarity matrix
  console.log('\n─── Matriz de similitud (primeros 5 docs) ───');
  const header = documents.slice(0, 5).map(d => d.id.padEnd(14)).join(' | ');
  console.log(`${''.padEnd(14)} | ${header}`);
  for (let i = 0; i < 5; i++) {
    const row = [];
    for (let j = 0; j < 5; j++) {
      const sim = cosineSim(docEmbeddings[i], docEmbeddings[j]);
      row.push(sim.toFixed(4).padEnd(14));
    }
    console.log(`${documents[i].id.padEnd(14)} | ${row.join(' | ')}`);
  }

  console.log('\nDone.');
}

main().catch(console.error);
