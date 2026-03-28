# js-vector-server

Vector database as a service on Cloudflare Workers. Zero dependencies beyond `js-vector-store`.

## Setup

```bash
cd server
npm install

# Create KV namespace
npx wrangler kv namespace create VECTOR_KV
# Copy the id into wrangler.toml

# Set API token
npx wrangler secret put API_TOKEN

# Local dev
npm run dev

# Deploy
npm run deploy
```

## Configuration (wrangler.toml)

| Variable | Default | Options |
|---|---|---|
| `STORE_TYPE` | `binary` | `float32`, `int8`, `binary` |
| `DIMENSIONS` | `768` | Any positive integer |
| `API_TOKEN` | `""` | Set via `wrangler secret put` |

## API

All endpoints require `Authorization: Bearer <token>` header (if API_TOKEN is set).

Base URL: `https://js-vector-server.<your-subdomain>.workers.dev`

### Service info

```
GET /
```

### Collections

```bash
# List collections
GET /v1/collections

# Drop collection
DELETE /v1/collections/:col

# Collection stats
GET /v1/stats
```

### Vectors

```bash
# Insert/update vector
POST /v1/collections/:col/vectors
{ "id": "doc-1", "vector": [0.1, 0.2, ...], "metadata": { "text": "..." } }

# Batch insert
POST /v1/collections/:col/vectors/batch
{ "vectors": [{ "id": "doc-1", "vector": [...], "metadata": {} }, ...] }

# Get vector by ID
GET /v1/collections/:col/vectors/:id

# Delete vector
DELETE /v1/collections/:col/vectors/:id

# Count vectors
GET /v1/collections/:col/count

# List IDs
GET /v1/collections/:col/ids
```

### Search

```bash
# Brute-force search
POST /v1/collections/:col/search
{ "vector": [0.1, 0.2, ...], "limit": 5, "metric": "cosine" }
# metric: "cosine" | "euclidean" | "dotProduct" | "manhattan"

# Matryoshka multi-stage search
POST /v1/collections/:col/matryoshka
{ "vector": [0.1, ...], "limit": 5, "stages": [128, 384, 768], "metric": "cosine" }

# Cross-collection search (with score normalization)
POST /v1/search-across
{ "collections": ["articles", "products"], "vector": [0.1, ...], "limit": 10 }
```

### Response format

```json
{ "success": true, "result": { ... } }
{ "success": false, "error": "message" }
```

## Examples

### Index + search with curl

```bash
URL="http://localhost:8787"
TOKEN="my-secret-token"
AUTH="Authorization: Bearer $TOKEN"

# Insert a vector
curl -X POST "$URL/v1/collections/docs/vectors" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"id":"doc-1","vector":[0.1,0.2,0.3],"metadata":{"text":"hello"}}'

# Search
curl -X POST "$URL/v1/collections/docs/search" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"vector":[0.1,0.2,0.3],"limit":5}'
```

### With Workers AI embeddings

```bash
# Generate embedding
EMBEDDING=$(curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/run/@cf/google/embeddinggemma-300m" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":["artificial intelligence in healthcare"]}' | jq '.result.data[0]')

# Index it
curl -X POST "$URL/v1/collections/docs/vectors" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"id\":\"doc-1\",\"vector\":$EMBEDDING,\"metadata\":{\"text\":\"AI in healthcare\"}}"

# Search with another embedding
QUERY=$(curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai/run/@cf/google/embeddinggemma-300m" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":["medical diagnosis with AI"]}' | jq '.result.data[0]')

curl -X POST "$URL/v1/collections/docs/search" \
  -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"vector\":$QUERY,\"limit\":5}"
```

## Storage costs

Using BinaryQuantizedStore (default):

| Vectors | KV Storage | KV cost |
|---|---|---|
| 10,000 | 960 KB | Free |
| 100,000 | 9.4 MB | Free (10GB included) |
| 1,000,000 | 91.6 MB | Free |

Workers KV includes 1GB free storage on the free plan and 10GB on paid.
