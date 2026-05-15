# js-vector-store

Skill para interactuar con el MCP server de js-vector-store.

## Proposito

Motor de busqueda semantica y vectorial con embeddings locales via Ollama. Permite indexar documentos, buscar por similitud semantica, keyword (BM25), o hibrido (ambos combinados).

## Workflow recomendado

### Paso 1: Crear coleccion

Usa `vector_collection_create` antes de indexar documentos.

Ejemplo: El usuario dice "quiero buscar en mis documentos".
- Tu accion: `vector_collection_create({ name: "docs", dimension: 768, backend: "float32", enableBM25: true })`

### Paso 2: Indexar documentos

Usa `vector_index_text` para cada documento. Esta herramienta:
1. Genera el embedding via Ollama local (embeddinggemma, 768 dim)
2. Almacena el vector en el store
3. Agrega el texto al indice BM25 para busqueda keyword

Ejemplo:
- `vector_index_text({ collection: "docs", id: "doc-1", text: "La IA revoluciona la medicina...", metadata: { source: "articulo-1" } })`

### Paso 3: Buscar

- **Busqueda semantica pura**: `vector_search({ collection: "docs", query: "inteligencia artificial en salud", limit: 5 })`
- **Busqueda keyword**: `vector_bm25_search({ collection: "docs", query: "medicina diagnostico", limit: 5 })`
- **Busqueda hibrida** (recomendada): `vector_hybrid_search({ collection: "docs", query: "IA aplicada a hospitales", limit: 5 })`

### Paso 4: Cross-collection (opcional)

Si hay multiples colecciones (docs, faqs, articles):
- `vector_cross_search({ collections: ["docs", "faqs"], query: "...", limit: 5 })`

## Cuando usar cada modo de busqueda

| Modo | Cuando usar | Pros/Cons |
|------|-------------|-----------|
| vector_search | Queries conceptuales, parafrases, significado | Pros: entiende semantica. Cons: puede fallar con terminos tecnicos exactos |
| vector_bm25_search | Terminos exactos, codigos, nombres propios | Pros: rapido, preciso con keywords. Cons: no entiende sinonimos |
| vector_hybrid_search | La mayoria de queries en lenguaje natural | Pros: lo mejor de ambos. Cons: ligeramente mas lento |
| vector_cross_search | Buscar en multiples dominios al mismo tiempo | Pros: descubre contenido disperso. Cons: mas resultados para filtrar |

## Consejos de indexacion

- Usa IDs semanticos: `doc-1`, `article-hello-world`, `faq-precios`
- Incluye metadata util: { title, author, date, tags, url, source }
- El texto completo debe ir en `text` para BM25; metadata no se indexa keyword
- Para documentos largos, considera chunking manual antes de indexar

## Modelo de embeddings

- Default: embeddinggemma:latest via Ollama en localhost:11434
- Dimension: 768
- Override via OLLAMA_MODEL y OLLAMA_HOST env vars


## Encriptacion

- Activa encriptacion de metadata con la variable de entorno ENCRYPTION_KEY. Los archivos JSON (metadata de colecciones) se encriptan con AES-256-GCM via PBKDF2; los vectores binarios (.bin) permanecen sin encriptar por rendimiento.
- ector_collection_create acepta encrypted: true para marcar la coleccion como sensible.

## Encriptacion

- Activa encriptacion de metadata con la variable de entorno `ENCRYPTION_KEY`. Los archivos JSON (metadata de colecciones) se encriptan con AES-256-GCM via PBKDF2; los vectores binarios (.bin) permanecen sin encriptar por rendimiento.
- `vector_collection_create` acepta `encrypted: true` para marcar la coleccion como sensible.

## Git Storage (versionado)

- Activa commits automaticos con `GIT_STORAGE=1`. La metadata JSON se commitea automaticamente en cada persistencia.
- Personaliza el mensaje con `GIT_COMMIT_MESSAGE`.
- Los vectores binarios (.bin) tambien se trackean si estan en el mismo directorio.

## Limitaciones

- No genera embeddings por si mismo: requiere Ollama corriendo
- Indexacion es sincrona: documentos grandes pueden tardar
- Sin autenticacion en la API REST (agregar reverse proxy si es publico)
