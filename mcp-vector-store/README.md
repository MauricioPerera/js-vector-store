# js-vector-store-headless

Headless semantic search API powered by [js-vector-store](https://github.com/MauricioPerera/js-vector-store) and local Ollama embeddings.

Zero-dependency vector database with semantic (cosine similarity), keyword (BM25), and hybrid search (RRF). All embeddings generated locally via Ollama — no API keys needed.

## Features

- **Semantic search** — cosine similarity over Float32, Int8, or Binary quantized vectors
- **Keyword search** — BM25 lexical ranking for exact term matching
- **Hybrid search** — RRF fusion of semantic + keyword for best accuracy
- **Cross-collection search** — search across multiple domains simultaneously
- **Local embeddings** — Ollama (embeddinggemma, nomic-embed, etc.) — no cloud required
- **MCP Server** — 12 tools for Codex/Claude LLM integration
- **REST API** — endpoints for any frontend or service
- **Zero-dep core** — js-vector-store itself has zero npm dependencies

## Quick Start

### Prerequisites

- [Ollama](https://ollama.com) installed and running
- An embedding model pulled: `ollama pull embeddinggemma` (or nomic-embed-text, etc.)

### Start the API

```bash
npm install js-vector-store-headless
npx js-vector-store-headless api
```

The API will be at `http://localhost:3000`.

### Index documents

```bash
curl -X POST http://localhost:3000/collections/docs \
  -H "Content-Type: application/json" \
  -d '{"id":"doc-1","text":"La IA revoluciona la medicina...","metadata":{"category":"salud"}}'
```

### Search

```bash
# Semantic search
curl "http://localhost:3000/collections/docs?q=inteligencia%20artificial%20en%20salud&limit=5"

# Keyword search
curl "http://localhost:3000/collections/docs?q=diagnostico%20medico&mode=bm25&limit=5"

# Hybrid search (recommended)
curl "http://localhost:3000/collections/docs?q=machine%20learning%20hospitales&mode=hybrid&limit=5"
```

## MCP Server (for LLMs)

```bash
npx js-vector-store-headless mcp
```

Tools available:

| Tool | Purpose |
|------|---------|
| `vector_collection_create` | Create a collection (float32/int8/binary backend) |
| `vector_collection_list` | List all collections |
| `vector_collection_info` | Stats: count, dimension, sample docs |
| `vector_index_text` | Generate embedding via Ollama and index |
| `vector_index` | Index a pre-computed embedding vector |
| `vector_search` | Semantic similarity search |
| `vector_bm25_add` | Add text to BM25 keyword index |
| `vector_bm25_search` | Keyword-only search |
| `vector_hybrid_search` | Vector + BM25 RRF fusion |
| `vector_cross_search` | Search across multiple collections |
| `vector_remove` | Delete a document |
| `vector_usage_guide` | Full usage guide for LLMs |

## Architecture

```
User Query
    |
    v
[Ollama] --generates embedding--> [VectorStore] --cosine sim--> Results
    |                                   ^
    v                                   |
[BM25Index] --keyword score----------> [HybridSearch] --RRF--> Final Ranking
```

## REST API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Status + Ollama model info |
| GET | `/collections` | List collections |
| POST | `/collections/:name` | Index document |
| GET | `/collections/:name?q=...` | Search (vector/bm25/hybrid) |
| GET | `/collections/:name/:id` | Get document |
| DELETE | `/collections/:name/:id` | Delete document |

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API URL |
| `OLLAMA_MODEL` | `embeddinggemma:latest` | Embedding model |
| `PORT` | `3000` | API server port |
| `DATA_DIR` | `./vector-data` | Storage directory |

## Backend Options

| Backend | Compression | Use Case |
|---------|-------------|----------|
| `float32` | 1x | Best accuracy, small datasets |
| `int8` | ~4x | Balanced accuracy/size |
| `binary` | ~32x | Maximum compression, large scale |

## Integration with Codex/Claude

```bash
codex mcp add js-vector-store -- node /path/to/vector-store-server.js
```

The LLM can then:
- Create collections on demand
- Index documents by generating embeddings automatically
- Search semantically, by keyword, or hybrid
- Build RAG pipelines with retrieved context

## License

MIT
