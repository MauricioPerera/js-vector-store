# js-vector-store en el browser / serverless

DB vectorial **sin servidor**: el índice vive en memoria, se serializa a UN `ArrayBuffer`
(el "archivo", modelo SQLite) y se persiste en **IndexedDB** o se carga read-only desde una
**URL**. Corre en browser, Cloudflare Worker y Node — zero-dependency.

## Probar el demo
```bash
# desde la raíz del repo, cualquier server estático:
python -m http.server 8099
# abrir http://localhost:8099/examples/browser/index.html
```
Construir índice → Guardar en IndexedDB → recargar la página → Recargar desde IndexedDB → Consultar.
Todo client-side, sin red.

## La API de "archivo portable"
```js
// La lib se expone como global `JSVectorStore` en el browser (o require() en Node/bundler).
const { BinaryQuantizedStore, MemoryStorageAdapter,
        idbSaveBundle, idbLoadBundle, fetchBundle } = JSVectorStore;

// 1) Construir en memoria (tus embeddings; aquí 1-bit por memoria/velocidad)
const adapter = new MemoryStorageAdapter();
const store   = new BinaryQuantizedStore(adapter, 256);
store.set("docs", "id1", embedding, { tag: "x" });
store.flush("docs");

// 2) Serializar todo a UN ArrayBuffer
const bundle = adapter.toBundle();

// 3a) Persistir en el browser (IndexedDB)
await idbSaveBundle("mi-indice", bundle);
const ab    = await idbLoadBundle("mi-indice");
const store2 = new BinaryQuantizedStore(MemoryStorageAdapter.fromBundle(ab), 256);

// 3b) O cargar read-only desde una URL/CDN/R2 (el modelo "shippeás el .jvs")
const remote = new BinaryQuantizedStore(
  MemoryStorageAdapter.fromBundle(await fetchBundle("https://cdn.example.com/index.jvs")), 256);

store2.search("docs", queryEmbedding, 5);             // + filtros de metadata, BM25, híbrido
```

## Por qué binario en el edge
Memoria por vector (dim 768): float32 **3 KB**, int8 **768 B**, **binario 96 B**. Un Cloudflare
Worker tiene **128 MB** → en binario te entra ~1M de vectores; en float32, ni 50k. Por eso para el
caso serverless/edge, `BinaryQuantizedStore` es el camino por defecto (y además ~7-8x más rápido).

## Nota sobre sync/async
El store es **síncrono** (consultas rápidas en memoria). La persistencia es **explícita y async**
(`toBundle`/`fromBundle` + IndexedDB/`fetch`) — el mismo modelo que sql.js: cargás el "archivo" una
vez, consultás en memoria. No hay un adapter IndexedDB síncrono porque IndexedDB no lo permite.
