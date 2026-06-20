# Batería de tests

Suite de correctitud **offline** (sin embeddings, sin red) para `js-vector-store`. Usa el runner
nativo de Node (`node:test` + `node:assert`) — **cero dependencias**, acorde al ethos del repo.

```bash
npm test          # node --test "test/*.test.js"
```

Requiere Node ≥ 18 (runner `node:test`); el script usa el glob de `node --test` (Node ≥ 21).
Los vectores son **sintéticos y deterministas** (PRNG con semilla en `test/helpers.js`), así que
no hace falta Ollama ni Workers AI (a diferencia de los scripts `test-*.js` de la raíz, que sí
llaman a modelos externos y no forman parte de esta batería).

## Cobertura

| Archivo | Qué verifica |
|---|---|
| `math.test.js` | `normalize` (unitario), `cosineSim`/`euclideanDist`/`dotProduct`/`manhattanDist`, `computeScore` por métrica |
| `topkheap.test.js` | `TopKHeap`: top-k por score, orden descendente, k=1 |
| `matchfilter.test.js` | filtros Mongo-like: igualdad, `$eq/$ne/$gt/$gte/$lt/$lte/$in/$nin/$exists/$regex`, `$and/$or/$not`, bordes |
| `stores.test.js` | los 4 stores: `set/get/has/count/ids/remove/drop`, **self-search top-1**, filtro de metadata, métricas, vacío, round-trip exacto (float32), `matryoshkaSearch`, `searchAcross` |
| `persistence.test.js` | flush → recarga en un store nuevo sobre el mismo adapter; los datos y el search sobreviven |
| `ivf.test.js` | `IVFIndex.build` (`{numClusters, numVectors}`), self-search exhaustivo (probes=clusters), error sin build, ids válidos |
| `bm25.test.js` | `BM25Index`: ranking por keyword, término discriminante, `removeDocument`, export/import |
| `hybrid.test.js` | `HybridSearch` modos `rrf` y `weighted`; `textWeight=0` ≈ solo vector |
| `adapters.test.js` | `MemoryStorageAdapter` y `FileStorageAdapter` (round-trip bin/json + persistencia a disco + delete) |

## Cómo está construida

- **Invariante clave (embedding-free):** un vector almacenado es su propio vecino más cercano →
  `search(query = vec_i)` debe devolver `id_i` como top-1. Vale para los 4 stores (incluso los
  quantizados, donde `get` es lossy pero el ranking se preserva).
- `test/helpers.js`: PRNG determinista + `vec(seed)` + `populate(store, n)`.
