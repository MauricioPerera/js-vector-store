/**
 * Benchmark de js-vector-store con EmbeddingGemma (Workers AI)
 * Mide: indexación, búsqueda, cuantización, BinaryQuantized, IVF, Matryoshka, métricas, y escalabilidad
 */

const {
  VectorStore,
  QuantizedStore,
  BinaryQuantizedStore,
  IVFIndex,
  MemoryStorageAdapter,
  FileStorageAdapter,
  normalize,
  cosineSim,
  computeScore,
} = require('./js-vector-store');

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN  = process.env.CF_API_TOKEN;
const MODEL      = '@cf/google/embeddinggemma-300m';
const API_URL    = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`;

// ── Helpers ────────────────────────────────────────────────

function hrMs(start) {
  const [s, ns] = process.hrtime(start);
  return s * 1000 + ns / 1e6;
}

function fakeVec(dim) {
  return normalize(Array.from({ length: dim }, () => Math.random() * 2 - 1));
}

function fmt(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}us`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtBytes(b) {
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)}KB`;
  return `${(b / (1024 * 1024)).toFixed(2)}MB`;
}

function bar(value, max, width = 30) {
  const filled = Math.round((value / max) * width);
  return '#'.repeat(Math.max(0, filled)) + '-'.repeat(Math.max(0, width - filled));
}

async function getEmbeddings(texts) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: Array.isArray(texts) ? texts : [texts] }),
  });
  if (!res.ok) throw new Error(`Workers AI error ${res.status}: ${await res.text()}`);
  return (await res.json()).result.data;
}

function bench(label, fn, iterations = 1) {
  fn(); // warmup
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t = process.hrtime();
    fn();
    times.push(hrMs(t));
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return { label, avg, min: Math.min(...times), max: Math.max(...times), iterations };
}

function printBench(results) {
  const maxAvg = Math.max(...results.map(r => r.avg));
  for (const r of results) {
    console.log(`  ${r.label.padEnd(44)} avg=${fmt(r.avg).padEnd(10)} min=${fmt(r.min).padEnd(10)} [${bar(r.avg, maxAvg)}]`);
  }
}

// ── Corpus ─────────────────────────────────────────────────

const corpus = [
  'La inteligencia artificial esta revolucionando el diagnostico medico en hospitales',
  'Machine learning aplicado a la deteccion de fraudes en transacciones financieras',
  'Procesamiento de lenguaje natural para asistentes virtuales y chatbots',
  'Vision por computadora en vehiculos autonomos y sistemas de navegacion',
  'Bases de datos vectoriales para busqueda semantica a gran escala',
  'Infraestructura cloud para entrenamiento distribuido de modelos de IA',
  'Robotica industrial y automatizacion de lineas de produccion con deep learning',
  'Sistemas de recomendacion personalizados basados en embeddings de usuarios',
  'Modelos generativos de texto e imagenes con arquitecturas transformer',
  'Etica y sesgo algoritmico en sistemas de inteligencia artificial',
  'Computacion cuantica aplicada a optimizacion de redes neuronales',
  'Internet de las cosas y procesamiento de datos en el edge con IA',
  'Seguridad informatica y deteccion de anomalias con aprendizaje profundo',
  'Bioinformatica y analisis genomico con redes neuronales recurrentes',
  'Procesamiento de imagenes medicas con redes convolucionales profundas',
  'Optimizacion de cadenas de suministro con algoritmos de reinforcement learning',
  'Analisis de sentimiento en redes sociales con modelos de lenguaje',
  'Reconocimiento de voz y transcripcion automatica con modelos seq2seq',
  'Generacion de codigo fuente asistida por modelos de lenguaje grandes',
  'Prediccion de demanda energetica con series temporales y deep learning',
  'Deteccion de objetos en tiempo real con YOLO y arquitecturas eficientes',
  'Traduccion automatica neuronal multilingue con modelos encoder-decoder',
  'Aprendizaje federado para entrenar modelos sin compartir datos sensibles',
  'Redes generativas adversarias para sintesis de imagenes fotorrealistas',
  'Compresion de modelos con destilacion de conocimiento y pruning',
  'Analisis de grafos y redes sociales con graph neural networks',
  'Clustering no supervisado de documentos con embeddings contextuales',
  'Planificacion de rutas autonomas con aprendizaje por refuerzo profundo',
  'Monitoreo ambiental y deteccion de incendios con drones inteligentes',
  'Asistentes de escritura con modelos de lenguaje y retrieval augmented generation',
];

const queryTexts = [
  'inteligencia artificial aplicada a la salud y medicina',
  'deteccion de fraude financiero con aprendizaje automatico',
  'busqueda semantica y bases de datos vectoriales',
  'etica e inteligencia artificial responsable',
  'generacion de imagenes con redes neuronales',
  'robotica y automatizacion industrial',
  'procesamiento de lenguaje natural',
  'vision por computadora para vehiculos',
];

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════════════╗');
  console.log('║   BENCHMARK: js-vector-store + EmbeddingGemma (Workers AI) v2        ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════╝\n');

  let t0, elapsed;

  // ─── 1. Embedding latency ───────────────────────────────
  console.log('1. EMBEDDING LATENCY (Workers AI)\n');

  t0 = process.hrtime();
  const [singleEmb] = await getEmbeddings(['test de latencia single']);
  elapsed = hrMs(t0);
  const dim = singleEmb.length;
  console.log(`  Single text:       ${fmt(elapsed)} (dim=${dim})`);

  t0 = process.hrtime();
  await getEmbeddings(corpus.slice(0, 10));
  elapsed = hrMs(t0);
  console.log(`  Batch 10 texts:    ${fmt(elapsed)} (${fmt(elapsed / 10)}/text)`);

  t0 = process.hrtime();
  const allDocEmbeddings = await getEmbeddings(corpus);
  elapsed = hrMs(t0);
  console.log(`  Batch 30 texts:    ${fmt(elapsed)} (${fmt(elapsed / 30)}/text)`);

  t0 = process.hrtime();
  const allQueryEmbeddings = await getEmbeddings(queryTexts);
  elapsed = hrMs(t0);
  console.log(`  Batch 8 queries:   ${fmt(elapsed)} (${fmt(elapsed / 8)}/query)`);

  // ─── 2. Indexing ────────────────────────────────────────
  console.log('\n2. INDEXING PERFORMANCE (30 real embeddings)\n');

  const ITERS = 100;
  const results2 = [];

  results2.push(bench('VectorStore.set (Float32)', () => {
    const s = new VectorStore(new MemoryStorageAdapter(), dim);
    for (let i = 0; i < allDocEmbeddings.length; i++) s.set('docs', `doc-${i}`, allDocEmbeddings[i], { text: corpus[i] });
    s.flush();
  }, ITERS));

  results2.push(bench('QuantizedStore.set (Int8)', () => {
    const s = new QuantizedStore(new MemoryStorageAdapter(), dim);
    for (let i = 0; i < allDocEmbeddings.length; i++) s.set('docs', `doc-${i}`, allDocEmbeddings[i], { text: corpus[i] });
    s.flush();
  }, ITERS));

  results2.push(bench('BinaryQuantizedStore.set (1-bit)', () => {
    const s = new BinaryQuantizedStore(new MemoryStorageAdapter(), dim);
    for (let i = 0; i < allDocEmbeddings.length; i++) s.set('docs', `doc-${i}`, allDocEmbeddings[i], { text: corpus[i] });
    s.flush();
  }, ITERS));

  printBench(results2);

  // ─── 3. Search (30 docs, 8 queries) ────────────────────
  console.log('\n3. SEARCH PERFORMANCE (30 docs, 8 queries)\n');

  const f32 = new VectorStore(new MemoryStorageAdapter(), dim);
  const q8  = new QuantizedStore(new MemoryStorageAdapter(), dim);
  const b1  = new BinaryQuantizedStore(new MemoryStorageAdapter(), dim);
  for (let i = 0; i < allDocEmbeddings.length; i++) {
    f32.set('docs', `doc-${i}`, allDocEmbeddings[i], { text: corpus[i] });
    q8.set('docs', `doc-${i}`, allDocEmbeddings[i], { text: corpus[i] });
    b1.set('docs', `doc-${i}`, allDocEmbeddings[i], { text: corpus[i] });
  }
  f32.flush(); q8.flush(); b1.flush();

  const results3 = [];

  results3.push(bench('Float32 brute-force (top-5)', () => {
    for (const qe of allQueryEmbeddings) f32.search('docs', qe, 5);
  }, 500));

  results3.push(bench('Int8 brute-force (top-5)', () => {
    for (const qe of allQueryEmbeddings) q8.search('docs', qe, 5);
  }, 500));

  results3.push(bench('Binary 1-bit Hamming (top-5)', () => {
    for (const qe of allQueryEmbeddings) b1.search('docs', qe, 5);
  }, 500));

  results3.push(bench('Float32 Matryoshka [128,384,768]', () => {
    for (const qe of allQueryEmbeddings) f32.matryoshkaSearch('docs', qe, 5, [128, 384, 768]);
  }, 500));

  results3.push(bench('Binary Matryoshka [128,384,768]', () => {
    for (const qe of allQueryEmbeddings) b1.matryoshkaSearch('docs', qe, 5, [128, 384, 768]);
  }, 500));

  printBench(results3);

  // ─── 4. Distance metrics comparison ────────────────────
  console.log('\n4. DISTANCE METRICS (Float32, 30 docs, 8 queries)\n');

  const metrics = ['cosine', 'euclidean', 'dotProduct', 'manhattan'];
  const results4 = [];
  for (const m of metrics) {
    results4.push(bench(`${m}`, () => {
      for (const qe of allQueryEmbeddings) f32.search('docs', qe, 5, 0, m);
    }, 200));
  }
  printBench(results4);

  // ─── 5. Scale benchmark ────────────────────────────────
  console.log('\n5. SCALE BENCHMARK (synthetic, dim=768)\n');

  const sizes = [100, 500, 1000, 5000, 10000];

  // Insert
  console.log('  Insert (avg per vector):');
  for (const N of sizes) {
    const store = new VectorStore(new MemoryStorageAdapter(), dim);
    t0 = process.hrtime();
    for (let i = 0; i < N; i++) store.set('bulk', `v-${i}`, fakeVec(dim), { i });
    store.flush();
    const ms = hrMs(t0);
    console.log(`    N=${String(N).padEnd(6)} ${fmt(ms / N)}/vec`);
  }

  // Search comparison: Float32 vs Binary at scale
  console.log('\n  Search Float32 vs Binary (top-10):');
  const scaleResults = [];
  for (const N of sizes) {
    const sf = new VectorStore(new MemoryStorageAdapter(), dim);
    const sb = new BinaryQuantizedStore(new MemoryStorageAdapter(), dim);
    for (let i = 0; i < N; i++) {
      const v = fakeVec(dim);
      sf.set('bulk', `v-${i}`, v, { i });
      sb.set('bulk', `v-${i}`, v, { i });
    }
    sf.flush(); sb.flush();

    const q = fakeVec(dim);
    const iters = Math.max(10, Math.floor(5000 / N));

    const rf = bench(`F32 N=${N}`, () => sf.search('bulk', q, 10), iters);
    const rb = bench(`B1  N=${N}`, () => sb.search('bulk', q, 10), iters);
    scaleResults.push(rf, rb);
  }

  const maxScale = Math.max(...scaleResults.map(r => r.avg));
  for (let i = 0; i < scaleResults.length; i += 2) {
    const rf = scaleResults[i], rb = scaleResults[i + 1];
    const speedup = rf.avg / rb.avg;
    console.log(`    ${rf.label.padEnd(16)} ${fmt(rf.avg).padEnd(10)} | ${rb.label.padEnd(16)} ${fmt(rb.avg).padEnd(10)} | B1 ${speedup.toFixed(1)}x`);
  }

  // ─── 6. IVF benchmark ──────────────────────────────────
  console.log('\n6. IVF INDEX BENCHMARK (N=5000, QuantizedStore)\n');

  const bigStore = new QuantizedStore(new MemoryStorageAdapter(), dim);
  for (let i = 0; i < 5000; i++) bigStore.set('corpus', `v-${i}`, fakeVec(dim), { i });
  bigStore.flush();

  const q = fakeVec(dim);
  const bruteResult = bench('Brute-force (baseline)', () => bigStore.search('corpus', q, 10), 50);
  console.log(`  Baseline brute-force:  avg=${fmt(bruteResult.avg)}`);

  const probeConfigs = [
    { clusters: 25,  probes: 3 },
    { clusters: 50,  probes: 5 },
    { clusters: 50,  probes: 10 },
    { clusters: 100, probes: 10 },
  ];

  console.log('');
  console.log('  Config'.padEnd(46) + 'build'.padEnd(12) + 'search avg'.padEnd(12) + 'speedup');
  console.log('  ' + '-'.repeat(74));
  for (const cfg of probeConfigs) {
    const ivf = new IVFIndex(bigStore, cfg.clusters, cfg.probes);
    t0 = process.hrtime();
    ivf.build('corpus');
    const buildMs = hrMs(t0);
    const sb = bench(`IVF K=${cfg.clusters} P=${cfg.probes}`, () => ivf.search('corpus', q, 10), 100);
    const speedup = bruteResult.avg / sb.avg;
    console.log(`  ${sb.label.padEnd(44)} ${fmt(buildMs).padEnd(12)} ${fmt(sb.avg).padEnd(12)} ${speedup.toFixed(1)}x`);
  }

  // ─── 7. Memory footprint ───────────────────────────────
  console.log('\n7. MEMORY FOOTPRINT\n');

  const footprints = [
    { label: 'Float32 768d', perVec: dim * 4 },
    { label: 'Int8    768d', perVec: dim + 8 },
    { label: 'Binary  768d', perVec: Math.ceil(dim / 8) },
  ];
  const counts = [100, 1000, 10000, 100000, 1000000];

  console.log('  ' + 'Format'.padEnd(16) + counts.map(n => `N=${n}`.padEnd(12)).join(''));
  console.log('  ' + '-'.repeat(76));
  for (const fp of footprints) {
    const cols = counts.map(n => fmtBytes(fp.perVec * n).padEnd(12)).join('');
    console.log(`  ${fp.label.padEnd(16)}${cols}`);
  }

  // ─── 8. Recall quality ─────────────────────────────────
  console.log('\n8. RECALL QUALITY (real embeddings, 30 docs)\n');

  const groundTruth = allQueryEmbeddings.map(qe =>
    f32.search('docs', qe, 5).map(r => r.id)
  );

  function recall(results, truth, k = 5) {
    let total = 0;
    for (let q = 0; q < truth.length; q++) {
      const gt  = new Set(truth[q].slice(0, k));
      const res = new Set(results[q].slice(0, k));
      let hits = 0;
      for (const id of res) if (gt.has(id)) hits++;
      total += hits / k;
    }
    return total / truth.length;
  }

  // Int8
  const q8Res = allQueryEmbeddings.map(qe => q8.search('docs', qe, 5).map(r => r.id));
  console.log(`  Int8 brute-force vs Float32:      recall@5 = ${(recall(q8Res, groundTruth) * 100).toFixed(1)}%`);

  // Binary
  const b1Res = allQueryEmbeddings.map(qe => b1.search('docs', qe, 5).map(r => r.id));
  const b1Recall = recall(b1Res, groundTruth);
  console.log(`  Binary 1-bit vs Float32:          recall@5 = ${(b1Recall * 100).toFixed(1)}%`);

  // Binary top-1
  const b1Top1 = allQueryEmbeddings.map(qe => b1.search('docs', qe, 1).map(r => r.id));
  const gtTop1 = allQueryEmbeddings.map(qe => f32.search('docs', qe, 1).map(r => r.id));
  const top1Match = b1Top1.reduce((acc, r, i) => acc + (r[0] === gtTop1[i][0] ? 1 : 0), 0);
  console.log(`  Binary 1-bit vs Float32:          top-1 match = ${top1Match}/${allQueryEmbeddings.length}`);

  // Matryoshka Float32
  const matF32 = allQueryEmbeddings.map(qe =>
    f32.matryoshkaSearch('docs', qe, 5, [128, 384, 768]).map(r => r.id)
  );
  console.log(`  Float32 Matryoshka [128,384,768]:  recall@5 = ${(recall(matF32, groundTruth) * 100).toFixed(1)}%`);

  // Binary Matryoshka
  const matB1 = allQueryEmbeddings.map(qe =>
    b1.matryoshkaSearch('docs', qe, 5, [128, 384, 768]).map(r => r.id)
  );
  console.log(`  Binary Matryoshka [128,384,768]:   recall@5 = ${(recall(matB1, groundTruth) * 100).toFixed(1)}%`);

  // ─── 9. Disk I/O ───────────────────────────────────────
  console.log('\n9. DISK I/O BENCHMARK (FileStorageAdapter)\n');

  const fs = require('fs');
  const tmpDir = require('os').tmpdir() + '/js-vector-bench-' + Date.now();

  const diskF32 = new VectorStore(tmpDir + '/f32', dim);
  const diskQ8  = new QuantizedStore(tmpDir + '/q8', dim);
  const diskB1  = new BinaryQuantizedStore(tmpDir + '/b1', dim);

  t0 = process.hrtime();
  for (let i = 0; i < allDocEmbeddings.length; i++) diskF32.set('docs', `doc-${i}`, allDocEmbeddings[i], { text: corpus[i] });
  diskF32.flush();
  const writeF32 = hrMs(t0);

  t0 = process.hrtime();
  for (let i = 0; i < allDocEmbeddings.length; i++) diskQ8.set('docs', `doc-${i}`, allDocEmbeddings[i], { text: corpus[i] });
  diskQ8.flush();
  const writeQ8 = hrMs(t0);

  t0 = process.hrtime();
  for (let i = 0; i < allDocEmbeddings.length; i++) diskB1.set('docs', `doc-${i}`, allDocEmbeddings[i], { text: corpus[i] });
  diskB1.flush();
  const writeB1 = hrMs(t0);

  const f32BinSize = fs.statSync(tmpDir + '/f32/docs.bin').size;
  const q8BinSize  = fs.statSync(tmpDir + '/q8/docs.q8.bin').size;
  const b1BinSize  = fs.statSync(tmpDir + '/b1/docs.b1.bin').size;

  console.log(`  Float32: write=${fmt(writeF32).padEnd(10)} bin=${fmtBytes(f32BinSize)}`);
  console.log(`  Int8:    write=${fmt(writeQ8).padEnd(10)} bin=${fmtBytes(q8BinSize)}`);
  console.log(`  Binary:  write=${fmt(writeB1).padEnd(10)} bin=${fmtBytes(b1BinSize)}`);

  fs.rmSync(tmpDir, { recursive: true, force: true });

  // ─── Summary ───────────────────────────────────────────
  console.log('\n╔═══════════════════════════════════════════════════════════════════════╗');
  console.log('║                            SUMMARY                                   ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════╝');
  console.log(`  Model:              ${MODEL}`);
  console.log(`  Dimensions:         ${dim}`);
  console.log(`  Corpus:             ${corpus.length} docs, ${queryTexts.length} queries`);
  console.log(`  Stores:             Float32, Int8, Binary (1-bit)`);
  console.log(`  Metrics:            cosine, euclidean, dotProduct, manhattan`);
  console.log(`  Int8 recall@5:      ${(recall(q8Res, groundTruth) * 100).toFixed(1)}%`);
  console.log(`  Binary recall@5:    ${(b1Recall * 100).toFixed(1)}%`);
  console.log(`  Binary top-1:       ${top1Match}/${allQueryEmbeddings.length}`);
  console.log(`  Compression:        F32=3072B  Q8=776B (4x)  B1=96B (32x)`);
  console.log('');
}

main().catch(console.error);
