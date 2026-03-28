/**
 * Test de autoSearch: cross-model search con modelo auto-detectado del manifest
 */

const {
  BinaryQuantizedStore,
  MemoryStorageAdapter,
  Reranker,
} = require('./js-vector-store');

const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
const CF_TOKEN   = process.env.CF_API_TOKEN;

const GEMMA = '@cf/google/embeddinggemma-300m';
const BGE   = '@cf/baai/bge-base-en-v1.5';

async function embed(texts, model) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/${model}`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: Array.isArray(texts) ? texts : [texts] }),
    }
  );
  if (!res.ok) throw new Error(`Embed error: ${res.status}`);
  return (await res.json()).result.data;
}

const docsA = [
  'La inteligencia artificial esta revolucionando el diagnostico medico',
  'Machine learning aplicado a la deteccion de fraudes financieros',
  'Procesamiento de lenguaje natural para chatbots empresariales',
];

const docsB = [
  'Vision por computadora en vehiculos autonomos',
  'Bases de datos vectoriales para busqueda semantica',
  'Robotica industrial y automatizacion con deep learning',
];

async function main() {
  console.log('=== Test autoSearch (modelo auto-detectado) ===\n');

  // 1. Crear UN solo store con DOS colecciones de modelos distintos
  const store = new BinaryQuantizedStore(new MemoryStorageAdapter(), 768);

  // Coleccion A: embedida con Gemma
  console.log('Embedding coleccion A con Gemma...');
  const embsA = await embed(docsA, GEMMA);
  store.setModel('col-gemma', GEMMA);
  for (let i = 0; i < docsA.length; i++) {
    store.set('col-gemma', `a-${i}`, embsA[i], { text: docsA[i] });
  }

  // Coleccion B: embedida con BGE
  console.log('Embedding coleccion B con BGE...');
  const embsB = await embed(docsB, BGE);
  store.setModel('col-bge', BGE);
  for (let i = 0; i < docsB.length; i++) {
    store.set('col-bge', `b-${i}`, embsB[i], { text: docsB[i] });
  }
  store.flush();

  // Verificar que el modelo se guardo
  console.log(`\nModelo col-gemma: ${store.getModel('col-gemma')}`);
  console.log(`Modelo col-bge:   ${store.getModel('col-bge')}\n`);

  // 2. autoSearch: solo pasa el TEXTO del query + colecciones
  //    El reranker auto-detecta el modelo, genera embeddings, busca, reranquea
  const reranker = Reranker.cloudflare(CF_ACCOUNT, CF_TOKEN);

  const queryText = 'diagnostico medico con inteligencia artificial';
  console.log(`Query: "${queryText}"\n`);

  // embedFn: lo que autoSearch llama internamente
  async function embedFn(text, model) {
    const [vec] = await embed([text], model);
    return vec;
  }

  console.log('autoSearch (modelo auto-detectado por coleccion)...\n');
  const results = await reranker.autoSearch(
    queryText,
    store,
    ['col-gemma', 'col-bge'],
    embedFn,
    { limit: 5, textField: 'text' }
  );

  for (const r of results) {
    console.log(`  [${r.score.toFixed(4)}] ${r.id} (${r.collection}) — ${r.metadata.text.slice(0, 55)}`);
  }

  const topCorrect = results[0].metadata.text.includes('inteligencia artificial');
  console.log(`\nTop-1 correct: ${topCorrect ? 'YES' : 'NO'}`);
  console.log('\nDone.');
}

main().catch(console.error);
