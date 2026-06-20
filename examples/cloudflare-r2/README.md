# Búsqueda vectorial en Cloudflare Workers + R2 (alternativa de costo mínimo a Vectorize)

Sirve un índice vectorial **read-only** desde R2: construís el índice offline, subís un solo `.jvs`
(bundle binario) a R2, y un Worker lo carga una vez por isolate y responde queries en memoria.
Sin base de datos, sin servidor: solo **storage R2 + cómputo del Worker**.

## Por qué binario
1-bit = **96 B/vector** (dim 768) → ~1M vectores entran en los **128 MB** de un Worker, y el índice
en R2 es pequeño (2000 vectores dim 256 ≈ 100 KB). float32 ni se acerca.

## Pasos

```bash
# 1) Construir el índice (reemplazá los vectores sintéticos por tus embeddings en build-index.js)
node build-index.js                 # escribe index.jvs

# 2) Crear el bucket y subir el índice
wrangler r2 bucket create jvs-index
wrangler r2 object put jvs-index/index.jvs --file index.jvs

# 3) Desplegar el Worker
wrangler deploy
```

## Consultar
```bash
curl -X POST https://jvs-r2-search.<tu-subdominio>.workers.dev/search \
  -H 'Content-Type: application/json' \
  -d '{"vector": [/* tu query embedding, 256 dims */], "limit": 5, "filter": {"group": 1}}'
```
Respuesta: `{ "results": [ { "id", "score", "metadata" }, ... ] }` — con filtros de metadata incluidos.

## Cómo está hecho
- `index.js` — el Worker. Cachea el store a nivel de isolate (`_cache`): la 1ª request carga el
  bundle de R2 (`env.INDEX.get`) y lo deserializa; las siguientes reusan el índice en memoria.
- Para **actualizar el índice**, re-subís el `.jvs` a R2 y los isolates lo recargan al rotar (o
  cambiás `INDEX_KEY` por versión: `index-v2.jvs`).
- Auth opcional: definí `API_TOKEN` en `wrangler.toml` → `/search` exige `Authorization: Bearer`.

## Límites honestos
- Modelo **read-only**: las escrituras se hacen rebuildeando el `.jvs` offline. Para upserts en
  vivo necesitás otra capa (KV/D1/DO), fuera del alcance de este ejemplo.
- R2 no tiene el límite de 25 MB/valor de KV → escalás el índice mucho más. El cuello pasa a ser la
  memoria del isolate y el tiempo de carga del bundle en frío (mitigado por el cache de isolate).
- Verificación: el handler está testeado en Node con un `env` mock de R2 (`test/worker-r2.test.js`).
  El runtime real se valida con `wrangler dev`.
