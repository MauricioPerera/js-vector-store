---
task: kmeans-init-flatten
intent: "Aplanar el anidamiento de _kmeansInit extrayendo el cálculo de distancia mínima."
target: ../../js-vector-store.js
signature: "_kmeansInit(flat, n, dim, k)"
budget: { cyclomatic_max: 8, nesting_max: 3, params_max: 4, lines_max: 25 }
deps_allowed: []
forbids: ["bucle triple anidado", "estado global", "cambiar el orden de Math.random"]
tests: test_flatten.js
test_command: node ccdd/17-flatten-nesting/test_flatten.js
language: javascript
issue: "MauricioPerera/js-vector-store#17"
require_test_approval: true
spec_version: "0.1"
tests_sha256: "04c2f6f21f2da3e43e9e0b52d195ea5ddcca7366408cd6e0dd3668e5ddce1d48"
---

## Intent
`_kmeansInit` (k-means++ de IVFIndex) tenía anidamiento 4 por un bucle triple. Extraer el cálculo
de "distancia² mínima a los centroides ya elegidos" a `_nearestCentroidDistSq`, bajando el
anidamiento a ≤3 sin cambiar el resultado (misma matemática, mismo consumo de `Math.random`).

> Parte de #17 (8 funciones en ALTA). Las otras dos de bajo riesgo (set@VectorStore, listKeys@
> CloudflareKVAdapter) van en el mismo PR, verificadas por el test de comportamiento (no por
> task_gate: sus nombres colisionan con métodos homónimos de otras clases — limitación de
> task_gate, que mide por nombre).

## Interface
```
in:  flat: Float64Array (n*dim), n: int, dim: int, k: int
out: Float64Array (k*dim) — k centroides iniciales (cada uno copia de un punto de `flat`)
error: no lanza
```

## Invariants
- Resultado idéntico al original para la MISMA secuencia de `Math.random` (no cambia el nº ni el
  orden de llamadas a `Math.random`).
- Cada centroide es copia exacta de un punto de `flat` (k-means++).
- `_nearestCentroidDistSq` es puro respecto a su entrada (no muta `flat`/`centroids`).

## Examples
- 200 casos (flat aleatorio seedeado, n/dim/k variados): `_kmeansInit === oráculo` byte a byte.
- Centroide 0 = `flat[first*dim .. ]` con `first = floor(random()*n)`.

## Do / Don't
- DO: extraer la distancia mínima a un helper; mantener el orden de las llamadas a `Math.random`.
- DON'T: reordenar las llamadas a `Math.random` (cambiaría la selección de centroides).

## Tests
Property-test congelado (`test_flatten.js`): equivalencia EXACTA de `_kmeansInit` contra un oráculo
(copia de la lógica original) con `Math.random` seedeado determinista, 200 casos; más
caracterización de `set` y `listKeys` (comportamiento observable preservado).

## Constraints
- NO cambiar la semántica observable ni el orden de consumo del RNG.
- PARAR y reportar si bajar el anidamiento exige cambiar el resultado numérico.
