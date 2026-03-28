/**
 * Test del API de js-vector-server desplegado
 */

const URL = process.env.SERVER_URL || 'http://localhost:8787';
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
  return (await res.json()).result.data;
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${URL}${path}`, opts);
  return res.json();
}

async function main() {
  console.log(`Testing: ${URL}\n`);

  // 1. Service info
  const info = await api('GET', '/');
  console.log('GET /');
  console.log(`  ${JSON.stringify(info.result)}\n`);

  // 2. Generate embeddings
  console.log('Generating embeddings...');
  const [vec1, vec2, vec3] = await embed([
    'Inteligencia artificial en medicina',
    'Machine learning para deteccion de fraudes',
    'Bases de datos vectoriales para busqueda semantica',
  ]);
  console.log(`  dim=${vec1.length}\n`);

  // 3. Batch insert
  console.log('POST /v1/collections/demo/vectors/batch');
  const batch = await api('POST', '/v1/collections/demo/vectors/batch', {
    vectors: [
      { id: 'doc-ia',  vector: vec1, metadata: { text: 'IA medicina' } },
      { id: 'doc-ml',  vector: vec2, metadata: { text: 'ML fraudes' } },
      { id: 'doc-vec', vector: vec3, metadata: { text: 'Vector DBs' } },
    ],
  });
  console.log(`  imported: ${batch.result.imported}\n`);

  // 4. Count
  const count = await api('GET', '/v1/collections/demo/count');
  console.log(`GET /v1/collections/demo/count`);
  console.log(`  count: ${count.result.count}\n`);

  // 5. Get by ID
  const got = await api('GET', '/v1/collections/demo/vectors/doc-ia');
  console.log(`GET /v1/collections/demo/vectors/doc-ia`);
  console.log(`  id: ${got.result.id}, metadata: ${JSON.stringify(got.result.metadata)}, vecLen: ${got.result.vector.length}\n`);

  // 6. Search
  console.log('Generating query embedding...');
  const [qvec] = await embed(['diagnostico medico con inteligencia artificial']);

  console.log('POST /v1/collections/demo/search');
  const search = await api('POST', '/v1/collections/demo/search', {
    vector: qvec, limit: 3,
  });
  console.log('  Results:');
  for (const r of search.result.results) {
    console.log(`    [${r.score.toFixed(4)}] ${r.id} — ${r.metadata.text}`);
  }

  // 7. Delete vector
  console.log('\nDELETE /v1/collections/demo/vectors/doc-ml');
  const del = await api('DELETE', '/v1/collections/demo/vectors/doc-ml');
  console.log(`  ${JSON.stringify(del.result)}`);

  // 8. Count after delete
  const count2 = await api('GET', '/v1/collections/demo/count');
  console.log(`\nCount after delete: ${count2.result.count}`);

  // 9. Stats
  const stats = await api('GET', '/v1/stats');
  console.log(`\nGET /v1/stats`);
  console.log(`  ${JSON.stringify(stats.result)}`);

  // 10. Drop collection
  console.log('\nDELETE /v1/collections/demo');
  const drop = await api('DELETE', '/v1/collections/demo');
  console.log(`  ${JSON.stringify(drop.result)}`);

  console.log('\nAll tests passed.');
}

main().catch(console.error);
