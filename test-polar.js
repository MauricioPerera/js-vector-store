/**
 * Test PolarQuantizedStore (3-bit) vs Float32, Int8, Binary
 */

const {
  VectorStore,
  QuantizedStore,
  BinaryQuantizedStore,
  PolarQuantizedStore,
  MemoryStorageAdapter,
  normalize,
  cosineSim,
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
  'La inteligencia artificial esta revolucionando el diagnostico medico',
  'Machine learning aplicado a la deteccion de fraudes financieros',
  'Procesamiento de lenguaje natural para chatbots empresariales',
  'Vision por computadora en vehiculos autonomos',
  'Bases de datos vectoriales para busqueda semantica',
  'Infraestructura cloud para despliegue de modelos de IA',
  'Robotica industrial y automatizacion con deep learning',
  'Sistemas de recomendacion basados en embeddings',
  'Modelos generativos de texto e imagenes con transformers',
  'Etica y sesgo en sistemas de inteligencia artificial',
];

const queries = [
  'inteligencia artificial en medicina',
  'deteccion de fraude con machine learning',
  'busqueda semantica con vectores',
  'etica en la inteligencia artificial',
];

async function main() {
  console.log('=== PolarQuantizedStore (3-bit) Test ===\n');

  console.log('Generating embeddings...');
  const [docEmbs, queryEmbs] = await Promise.all([
    embed(documents),
    embed(queries),
  ]);
  const dim = docEmbs[0].length;
  console.log(`Dim: ${dim}\n`);

  // Create all 4 stores
  const f32 = new VectorStore(new MemoryStorageAdapter(), dim);
  const q8  = new QuantizedStore(new MemoryStorageAdapter(), dim);
  const b1  = new BinaryQuantizedStore(new MemoryStorageAdapter(), dim);
  const p3  = new PolarQuantizedStore(new MemoryStorageAdapter(), dim, { bits: 3 });

  for (let i = 0; i < documents.length; i++) {
    f32.set('docs', `doc-${i}`, docEmbs[i], { text: documents[i] });
    q8.set('docs', `doc-${i}`, docEmbs[i], { text: documents[i] });
    b1.set('docs', `doc-${i}`, docEmbs[i], { text: documents[i] });
    p3.set('docs', `doc-${i}`, docEmbs[i], { text: documents[i] });
  }
  f32.flush(); q8.flush(); b1.flush(); p3.flush();

  // 1. Compression comparison
  console.log('1. COMPRESSION\n');
  console.log(`  Float32: ${dim * 4} bytes/vec`);
  console.log(`  Int8:    ${dim + 8} bytes/vec (${((dim * 4) / (dim + 8)).toFixed(1)}x)`);
  console.log(`  Binary:  ${Math.ceil(dim / 8)} bytes/vec (${((dim * 4) / Math.ceil(dim / 8)).toFixed(1)}x)`);
  console.log(`  Polar3:  ${p3.bytesPerVector()} bytes/vec (${((dim * 4) / p3.bytesPerVector()).toFixed(1)}x)`);

  // 2. Search quality comparison
  console.log('\n2. SEARCH QUALITY\n');

  let f32Top1 = 0, q8Top1 = 0, b1Top1 = 0, p3Top1 = 0;
  let q8Recall = 0, b1Recall = 0, p3Recall = 0;

  for (let q = 0; q < queries.length; q++) {
    const f32r = f32.search('docs', queryEmbs[q], 5).map(r => r.id);
    const q8r  = q8.search('docs', queryEmbs[q], 5).map(r => r.id);
    const b1r  = b1.search('docs', queryEmbs[q], 5).map(r => r.id);
    const p3r  = p3.search('docs', queryEmbs[q], 5).map(r => r.id);

    if (f32r[0] === q8r[0]) q8Top1++;
    if (f32r[0] === b1r[0]) b1Top1++;
    if (f32r[0] === p3r[0]) p3Top1++;

    const gt = new Set(f32r);
    q8Recall += q8r.filter(id => gt.has(id)).length / 5;
    b1Recall += b1r.filter(id => gt.has(id)).length / 5;
    p3Recall += p3r.filter(id => gt.has(id)).length / 5;

    const f32s = f32.search('docs', queryEmbs[q], 3);
    const p3s  = p3.search('docs', queryEmbs[q], 3);
    console.log(`  Query: "${queries[q]}"`);
    console.log(`    F32: [${f32s[0].score.toFixed(4)}] ${f32s[0].id}`);
    console.log(`    P3:  [${p3s[0].score.toFixed(4)}] ${p3s[0].id}`);
  }

  console.log(`\n  Top-1 match rate:`);
  console.log(`    Int8:    ${q8Top1}/${queries.length}`);
  console.log(`    Binary:  ${b1Top1}/${queries.length}`);
  console.log(`    Polar3:  ${p3Top1}/${queries.length}`);

  console.log(`\n  Recall@5 (vs Float32):`);
  console.log(`    Int8:    ${(q8Recall / queries.length * 100).toFixed(1)}%`);
  console.log(`    Binary:  ${(b1Recall / queries.length * 100).toFixed(1)}%`);
  console.log(`    Polar3:  ${(p3Recall / queries.length * 100).toFixed(1)}%`);

  // 3. Speed comparison
  console.log('\n3. SPEED (1000 searches)\n');
  function bench(label, fn, iters = 1000) {
    fn(); // warmup
    const t = process.hrtime();
    for (let i = 0; i < iters; i++) fn();
    const [s, ns] = process.hrtime(t);
    const ms = (s * 1000 + ns / 1e6) / iters;
    console.log(`  ${label.padEnd(12)} ${ms < 1 ? (ms*1000).toFixed(0)+'us' : ms.toFixed(2)+'ms'}/query`);
  }

  const q0 = queryEmbs[0];
  bench('Float32', () => f32.search('docs', q0, 5));
  bench('Int8',    () => q8.search('docs', q0, 5));
  bench('Binary',  () => b1.search('docs', q0, 5));
  bench('Polar3',  () => p3.search('docs', q0, 5));

  // 4. Different bit widths
  console.log('\n4. BIT WIDTH COMPARISON\n');
  for (const bits of [2, 3, 4, 5, 6]) {
    const store = new PolarQuantizedStore(new MemoryStorageAdapter(), dim, { bits });
    for (let i = 0; i < documents.length; i++) {
      store.set('docs', `doc-${i}`, docEmbs[i], { text: documents[i] });
    }
    store.flush();

    let top1 = 0, recall = 0;
    for (let q = 0; q < queries.length; q++) {
      const gt = f32.search('docs', queryEmbs[q], 5).map(r => r.id);
      const pr = store.search('docs', queryEmbs[q], 5).map(r => r.id);
      if (gt[0] === pr[0]) top1++;
      recall += pr.filter(id => new Set(gt).has(id)).length / 5;
    }
    console.log(`  ${bits}-bit: ${store.bytesPerVector()} bytes/vec (${((dim*4)/store.bytesPerVector()).toFixed(1)}x) | top-1: ${top1}/${queries.length} | recall@5: ${(recall/queries.length*100).toFixed(1)}%`);
  }

  console.log('\nDone.');
}

main().catch(console.error);
