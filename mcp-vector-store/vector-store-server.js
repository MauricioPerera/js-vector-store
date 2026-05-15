const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const z = require("zod/v4");
const path = require("path");

const { VectorStore, QuantizedStore, BinaryQuantizedStore, BM25Index, HybridSearch, MemoryStorageAdapter, FileStorageAdapter, IVFIndex } = require(path.join(__dirname, "js-vector-store.js"));
const { EncryptedAdapter, GitStorageAdapter } = require(path.join(__dirname, "..", "js-doc-store", "js-doc-store.js"));

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "embeddinggemma:latest";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "vector-data");

const server = new McpServer(
  { name: "js-vector-store", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

async function generateEmbedding(text) {
  const res = await fetch(OLLAMA_HOST + "/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: text }),
  });
  if (!res.ok) throw new Error(`Ollama embedding failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.embedding;
}

const collections = new Map();
const adapters = new Map();
const bm25s = new Map();
const hybrids = new Map();
const ivfIndexes = new Map();
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || null;

const GIT_STORAGE = process.env.GIT_STORAGE === "1" || process.env.GIT_STORAGE === "true";
const GIT_COMMIT_MESSAGE = process.env.GIT_COMMIT_MESSAGE || null;
const GIT_AUTO_PUSH = process.env.GIT_AUTO_PUSH === "1" || process.env.GIT_AUTO_PUSH === "true";
const GIT_PUSH_REMOTE = process.env.GIT_PUSH_REMOTE || "origin";
const GIT_PUSH_BRANCH = process.env.GIT_PUSH_BRANCH || "master";
const GIT_BATCH_INTERVAL = parseInt(process.env.GIT_BATCH_INTERVAL || "0", 10) * 1000;
const GIT_IGNORE_BIN = process.env.GIT_IGNORE_BIN === "1" || process.env.GIT_IGNORE_BIN === "true";

async function getAdapter(name) {
  if (adapters.has(name)) return adapters.get(name);
  const dir = path.join(DATA_DIR, name);
  let inner = new FileStorageAdapter(dir);
  if (ENCRYPTION_KEY) {
    inner = await EncryptedAdapter.create(inner, ENCRYPTION_KEY);
  }
  if (GIT_STORAGE) {
    const opts = { repoPath: dir };
    if (GIT_COMMIT_MESSAGE) opts.commitMessage = GIT_COMMIT_MESSAGE;
    if (GIT_AUTO_PUSH) { opts.autoPush = true; opts.pushRemote = GIT_PUSH_REMOTE; opts.pushBranch = GIT_PUSH_BRANCH; }
    if (GIT_BATCH_INTERVAL > 0) opts.batchIntervalMs = GIT_BATCH_INTERVAL;
    if (GIT_IGNORE_BIN) opts.ignoreBin = true;
    const adapter = new GitStorageAdapter(inner, opts);
    adapters.set(name, adapter);
    return adapter;
  }
  adapters.set(name, inner);
  return inner;
}

async function getCollection(name, dim = 768, backend = "float32") {
  if (collections.has(name)) return collections.get(name);
  const adapter = await getAdapter(name);
  if (typeof adapter.preloadAll === 'function') {
    try { await adapter.preloadAll(); } catch (e) { /* first run or plain */ }
  }
  let store;
  if (backend === "binary") store = new BinaryQuantizedStore(adapter, dim);
  else if (backend === "int8") store = new QuantizedStore(adapter, dim);
  else store = new VectorStore(adapter, dim);
  collections.set(name, store);
  return store;
}

async function persistStore(store) {
  store.flush();
  const adapter = store._adapter;
  if (adapter && typeof adapter.persist === 'function') {
    await adapter.persist();
  }
}

function getBM25(name) {
  if (!bm25s.has(name)) bm25s.set(name, new BM25Index());
  return bm25s.get(name);
}

async function getHybrid(name) {
  if (!hybrids.has(name)) {
    const store = await getCollection(name);
    const bm25 = getBM25(name);
    hybrids.set(name, new HybridSearch(store, bm25, "rrf"));
  }
  return hybrids.get(name);
}


function getIVF(name) {
  if (!ivfIndexes.has(name)) ivfIndexes.set(name, new IVFIndex(null, 100, 10));
  return ivfIndexes.get(name);
}

server.tool("vector_collection_create", "Create a new vector collection. Choose backend based on size requirements: float32 for accuracy, int8 for ~4x compression, binary for ~32x compression.", {
  name: z.string().describe("Collection name, e.g. docs, articles, products."),
  dimension: z.number().min(64).max(4096).default(768).describe("Embedding dimension. Must match your embedding model. embeddinggemma uses 768."),
  backend: z.enum(["float32", "int8", "binary"]).default("float32").describe("Storage backend: float32 = most accurate, int8 = ~4x compressed, binary = ~32x compressed."),
  metric: z.enum(["cosine", "euclidean", "dotProduct", "manhattan"]).default("cosine").describe("Distance metric for search."),
  enableBM25: z.boolean().default(true).describe("If true, enables keyword search (BM25) alongside vector search for hybrid queries."),
  encrypted: z.boolean().optional().describe("If true, marks collection as encrypted (metadata depends on ENCRYPTION_KEY env var).")
}, async (args) => {
  const store = await getCollection(args.name, args.dimension, args.backend);
  if (args.enableBM25) getBM25(args.name);
  return { content: [{ type: "text", text: JSON.stringify({ created: args.name, dimension: args.dimension, backend: args.backend, metric: args.metric, bm25: args.enableBM25 }, null, 2) }] };
});

server.tool("vector_collection_list", "List all vector collections with their stats: dimension, backend, vector count, and whether BM25 is enabled.", {}, async () => {
  const result = [];
  for (const [name, store] of collections) {
    const ids = store.ids(name);
    result.push({ name, count: ids.length, dimension: store.dim || store.dimension, backend: store.constructor.name });
  }
  return { content: [{ type: "text", text: JSON.stringify({ collections: result }, null, 2) }] };
});

server.tool("vector_collection_info", "Get detailed information about a specific collection: vector count, sample vectors, available IDs, and BM25 vocabulary size.", {
  name: z.string().describe("Collection name.")
}, async (args) => {
  const store = await getCollection(args.name);
  const ids = store.ids(args.name);
  const bm25 = bm25s.get(args.name);
  let sample = null;
  if (ids.length > 0) {
    const first = store.get(args.name, ids[0]);
    sample = { id: first.id, metadata: first.metadata };
  }
  return { content: [{ type: "text", text: JSON.stringify({ name: args.name, count: ids.length, ids: ids.slice(0, 20), sample, bm25Vocabulary: bm25 ? bm25.vocabularySize(args.name) : 0 }, null, 2) }] };
});

server.tool("vector_index_text", "Index a text document by generating its embedding via local Ollama and storing it. This is the PRIMARY way to add content for semantic search. Automatically chunks long texts.", {
  collection: z.string().describe("Target collection name."),
  id: z.string().describe("Unique document ID, e.g. doc-1, article-slug."),
  text: z.string().describe("Document text content. Will be embedded and indexed."),
  metadata: z.record(z.any()).optional().describe("Optional metadata: { title, author, tags, url, source }.")
}, async (args) => {
  const store = await getCollection(args.collection);
  const embedding = await generateEmbedding(args.text);
  const meta = { ...args.metadata, text: args.text };
  store.set(args.collection, args.id, embedding, meta);
  await persistStore(store);
  const bm25 = bm25s.get(args.collection);
  if (bm25) bm25.addDocument(args.collection, args.id, args.text);
  return { content: [{ type: "text", text: JSON.stringify({ indexed: args.id, collection: args.collection, embeddingDim: embedding.length, textLength: args.text.length }, null, 2) }] };
});

server.tool("vector_index", "Index a pre-computed embedding vector directly. Use when you already have embeddings from another source (OpenAI, HuggingFace, etc.).", {
  collection: z.string().describe("Target collection name."),
  id: z.string().describe("Unique document ID."),
  vector: z.array(z.number()).describe("Pre-computed embedding vector as array of floats."),
  metadata: z.record(z.any()).optional().describe("Optional metadata.")
}, async (args) => {
  const store = await getCollection(args.collection, args.vector.length);
  store.set(args.collection, args.id, args.vector, args.metadata);
  await persistStore(store);
  return { content: [{ type: "text", text: JSON.stringify({ indexed: args.id, collection: args.collection, dim: args.vector.length }, null, 2) }] };
});

server.tool("vector_search", "Search a collection using semantic similarity. Returns top-K most similar documents. You must provide either a query text (which will be embedded via Ollama) or a pre-computed query vector.", {
  collection: z.string().describe("Collection to search."),
  query: z.string().optional().describe("Query text to embed and search. Use this OR queryVector."),
  queryVector: z.array(z.number()).optional().describe("Pre-computed query embedding. Use this OR query."),
  limit: z.number().min(1).max(100).default(10).describe("Max results to return."),
  metric: z.enum(["cosine", "euclidean", "dotProduct", "manhattan"]).optional().describe("Override distance metric for this search.")
}, async (args) => {
  const store = await getCollection(args.collection);
  let qVec = args.queryVector;
  if (!qVec && args.query) qVec = await generateEmbedding(args.query);
  if (!qVec) throw new Error("Provide query text or queryVector.");
  const results = store.search(args.collection, qVec, args.limit, undefined, args.metric);
  return { content: [{ type: "text", text: JSON.stringify({ results: results.map(r => ({ id: r.id, score: r.score, metadata: r.metadata })) }, null, 2) }] };
});

server.tool("vector_bm25_add", "Add a text document to the BM25 keyword index for pure keyword/lexical search. Does NOT generate embeddings. Use alongside vector_index_text for full hybrid coverage.", {
  collection: z.string().describe("Collection name."),
  id: z.string().describe("Document ID."),
  text: z.string().describe("Text content for keyword indexing.")
}, async (args) => {
  const bm25 = getBM25(args.collection);
  bm25.addDocument(args.collection, args.id, args.text);
  return { content: [{ type: "text", text: JSON.stringify({ indexed: args.id, collection: args.collection, bm25Docs: bm25.count(args.collection) }, null, 2) }] };
});

server.tool("vector_bm25_search", "Search using BM25 keyword/lexical search. Returns documents ranked by keyword relevance. Faster than vector search but less semantic understanding. Good for exact term matching.", {
  collection: z.string().describe("Collection name."),
  query: z.string().describe("Keyword query, e.g. machine learning fraud detection."),
  limit: z.number().min(1).max(100).default(10).describe("Max results.")
}, async (args) => {
  const bm25 = getBM25(args.collection);
  const results = bm25.search(args.collection, args.query, args.limit);
  return { content: [{ type: "text", text: JSON.stringify({ results: results.map(r => ({ id: r.id, score: r.score })) }, null, 2) }] };
});

server.tool("vector_hybrid_search", "Combine semantic (vector) and keyword (BM25) search for best results. Uses RRF (Reciprocal Rank Fusion) by default. More accurate than either method alone for natural language queries.", {
  collection: z.string().describe("Collection name."),
  query: z.string().describe("Query text. Will be embedded for vector search AND used as keywords for BM25."),
  limit: z.number().min(1).max(100).default(10).describe("Max results."),
  strategy: z.enum(["rrf", "weighted"]).default("rrf").describe("Fusion strategy: rrf = Reciprocal Rank Fusion, weighted = weighted score sum.")
}, async (args) => {
  const store = await getCollection(args.collection);
  const bm25 = getBM25(args.collection);
  const qVec = await generateEmbedding(args.query);
  const hybrid = new HybridSearch(store, bm25, args.strategy);
  const results = hybrid.search(args.collection, qVec, args.query, args.limit);
  return { content: [{ type: "text", text: JSON.stringify({ results: results.map(r => ({ id: r.id, score: r.score, metadata: r.metadata })) }, null, 2) }] };
});

server.tool("vector_cross_search", "Search across MULTIPLE collections simultaneously. Useful when content is split across domains (e.g. docs, articles, faqs). Returns unified ranked results.", {
  collections: z.array(z.string()).describe("Array of collection names to search across."),
  query: z.string().describe("Query text."),
  limit: z.number().min(1).max(100).default(10).describe("Max results per collection, total may be higher."),
  topK: z.number().min(1).max(100).default(10).describe("Final number of results after merging and ranking."),
  strategy: z.enum(["rrf", "weighted"]).default("rrf").describe("Fusion strategy.")
}, async (args) => {
  const qVec = await generateEmbedding(args.query);
  const allResults = [];
  for (const colName of args.collections) {
    const store = await getCollection(colName);
    const bm25 = getBM25(colName);
    const hybrid = new HybridSearch(store, bm25, args.strategy);
    const results = hybrid.search(colName, qVec, args.query, args.limit);
    for (const r of results) {
      allResults.push({ ...r, collection: colName });
    }
  }
  allResults.sort((a, b) => b.score - a.score);
  const top = allResults.slice(0, args.topK);
  return { content: [{ type: "text", text: JSON.stringify({ results: top.map(r => ({ id: r.id, score: r.score, collection: r.collection, metadata: r.metadata })) }, null, 2) }] };
});

server.tool("vector_remove", "Remove a document by ID from both the vector store and BM25 index.", {
  collection: z.string().describe("Collection name."),
  id: z.string().describe("Document ID to remove.")
}, async (args) => {
  const store = await getCollection(args.collection);
  const removed = store.remove(args.collection, args.id);
  await persistStore(store);
  const bm25 = bm25s.get(args.collection);
  if (bm25) bm25.removeDocument(args.collection, args.id);
  return { content: [{ type: "text", text: JSON.stringify({ removed: args.id, success: removed }, null, 2) }] };
});

server.tool("vector_collection_build_ivf", "Build an IVF (K-means) approximate search index on a vector collection. This accelerates semantic search for large collections by clustering vectors into centroids and searching only nearby clusters. Use when a collection has more than ~1000 vectors and search latency matters.", {
  collection: z.string().describe("Collection name."),
  numClusters: z.number().min(2).max(1000).default(100).describe("Number of K-means clusters. More clusters = faster search, more memory."),
  numProbes: z.number().min(1).max(100).default(10).describe("How many clusters to search per query. More probes = higher recall, slower search."),
  sampleDims: z.number().min(1).max(4096).optional().describe("Optional: subsample dimensions for faster clustering. Default uses full dimension."),
}, async (args) => {
  const store = await getCollection(args.collection);
  const ivf = new IVFIndex(store, args.numClusters, args.numProbes);
  const result = ivf.build(args.collection, args.sampleDims || store.dim);
  return { content: [{ type: "text", text: JSON.stringify({ built: true, collection: args.collection, numClusters: result.numClusters, numVectors: result.numVectors }, null, 2) }] };
});

server.tool("vector_collection_search_ivf", "Search a vector collection using a pre-built IVF (K-means) index for approximate nearest neighbors. Faster than exact search for large collections. Must call vector_collection_build_ivf first.", {
  collection: z.string().describe("Collection name."),
  query: z.string().describe("Query text. Will be embedded via Ollama."),
  limit: z.number().min(1).max(100).default(10).describe("Max results."),
  metric: z.enum(["cosine", "euclidean", "dotProduct", "manhattan"]).default("cosine").describe("Distance metric."),
}, async (args) => {
  const store = await getCollection(args.collection);
  const ivf = getIVF(args.collection);
  ivf.store = store;
  ivf._loadIndex(args.collection);
  const qVec = await generateEmbedding(args.query);
  const results = ivf.search(args.collection, qVec, args.limit, [128, 256, args.limit * 4], args.metric);
  return { content: [{ type: "text", text: JSON.stringify({ collection: args.collection, query: args.query, results: results.map(r => ({ id: r.id, score: r.score, metadata: r.metadata })) }, null, 2) }] };
});

server.tool("vector_collection_cluster_info", "Get cluster statistics from an IVF index: centroid vectors, cluster sizes, and sample documents per cluster. Useful for understanding the semantic structure of your collection (e.g., topic discovery).", {
  collection: z.string().describe("Collection name."),
  maxSamplesPerCluster: z.number().min(1).max(20).default(3).describe("Max sample documents to show per cluster."),
}, async (args) => {
  const store = await getCollection(args.collection);
  const ivf = getIVF(args.collection);
  ivf.store = store;
  const idx = ivf._loadIndex(args.collection);
  if (!idx) throw new Error(`No IVF index found for ${args.collection}. Call vector_collection_build_ivf first.`);

  const entry = store._load(args.collection);
  const clusters = [];
  for (let c = 0; c < idx.centroids.length; c++) {
    const sampleIds = [];
    for (let i = 0; i < idx.assignments.length && sampleIds.length < args.maxSamplesPerCluster; i++) {
      if (idx.assignments[i] === c) sampleIds.push(entry.ids[i]);
    }
    const docs = sampleIds.map(id => {
      const doc = entry.meta[entry.ids.indexOf(id)];
      return { id, metadata: doc };
    });
    clusters.push({ clusterId: c, size: idx.assignments.filter(a => a === c).length, sampleIds, sampleDocuments: docs });
  }

  return { content: [{ type: "text", text: JSON.stringify({ collection: args.collection, numClusters: idx.centroids.length, clusters }, null, 2) }] };
});

server.tool("vector_usage_guide", "Get the complete usage guide for the Vector Store MCP. Call this when you need help with workflows, embedding models, or search strategies.", {
  topic: z.string().optional().describe("Optional topic: indexing, search, hybrid, models, deploy.")
}, async (args) => {
  const guide = `
# js-vector-store MCP - Usage Guide

## When to use each tool

### vector_collection_create
- Use FIRST before adding any documents to a new collection.
- Choose backend: float32 (best accuracy), int8 (~4x compressed), binary (~32x compressed).
- Enable BM25 if you plan to do hybrid search or keyword-only queries.

### vector_index_text
- PRIMARY tool for adding content. Generates embeddings via local Ollama automatically.
- Provide the raw text; the tool handles embedding generation and both vector + BM25 indexing.

### vector_search
- Use for pure semantic similarity queries.
- Provide natural language query text; it gets embedded automatically.
- Best for: conceptual queries, paraphrases, semantic meaning.

### vector_bm25_search
- Use for keyword/lexical queries where exact term matching matters.
- Best for: product codes, names, technical terms, quoted phrases.

### vector_hybrid_search
- Use when you want the best of both worlds: semantic + keyword.
- RRF (default) is robust and requires no tuning.
- Weighted allows controlling vector vs text importance.

### vector_cross_search
- Use when content is split across multiple collections/domains.
- Searches all specified collections and merges results.

## Embedding Models
- Default: embeddinggemma:latest (768 dim, via Ollama localhost:11434).
- Override via OLLAMA_MODEL env var.
- Ensure model dimension matches collection dimension.

## Workflow Example
1. vector_collection_create(name="docs", dimension=768, backend="float32")
2. vector_index_text(collection="docs", id="doc-1", text="Your document text...")
3. vector_hybrid_search(collection="docs", query="relevant question", limit=5)
4. Use results for RAG prompting or API response.
`;
  if (args.topic) {
    const section = guide.split("## " + args.topic.charAt(0).toUpperCase() + args.topic.slice(1))[1];
    if (section) return { content: [{ type: "text", text: "## " + args.topic.charAt(0).toUpperCase() + args.topic.slice(1) + section.split("##")[0] }] };
  }
  return { content: [{ type: "text", text: guide }] };
});

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error("js-vector-store MCP Server started on stdio (encryption: " + (ENCRYPTION_KEY ? "enabled" : "disabled") + ")");
  console.error("Tools: vector_collection_create, vector_collection_list, vector_collection_info,");
  console.error("         vector_index_text, vector_index, vector_search,");
  console.error("         vector_collection_build_ivf, vector_collection_search_ivf, vector_collection_cluster_info,");
  console.error("         vector_bm25_add, vector_bm25_search, vector_hybrid_search,");
  console.error("         vector_cross_search, vector_remove, vector_usage_guide");
});
