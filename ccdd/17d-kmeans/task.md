---
task: kmeans-lloyd-steps
intent: "Reducir la complejidad de _kmeans extrayendo los pasos de asignación/actualización."
target: ../../js-vector-store.js
signature: "_kmeans(flat, n, dim, k, maxIter)"
budget: { cyclomatic_max: 8, nesting_max: 3, params_max: 5, lines_max: 20 }
deps_allowed: []
forbids: ["bucle cuádruple anidado", "estado global", "cambiar el orden de Math.random"]
tests: test_kmeans.js
test_command: node ccdd/17d-kmeans/test_kmeans.js
language: javascript
issue: "MauricioPerera/js-vector-store#17"
require_test_approval: true
spec_version: "0.1"
tests_sha256: "ca8fa95cad1679ff5fde0285bea3296363e6ca33e3a0c2191788f7d70b09bca0"
---

## Intent
`_kmeans` (Lloyd) tenía anidamiento 4 / ciclomática 13 por el bucle de asignación cuádruple
anidado. Extraer `_nearestCentroid`, `_assignStep` y `_updateCentroids` sin cambiar el orden de
operaciones ni el consumo de `Math.random` (que ocurre solo en `_kmeansInit`, al inicio).

> Parte de #17 (la función MÁS sensible: RNG + iteración). Equivalencia byte a byte con semilla fija.

## Interface
```
_kmeans(flat, n, dim, k, maxIter=20) -> { centroids: number[][], assignments: number[] }
  firma y resultado sin cambios; misma semilla -> mismo resultado
```

## Invariants
- Con la MISMA secuencia de `Math.random`, resultado IDÉNTICO al original (centroids+assignments).
- `_kmeansInit` se llama una sola vez al inicio (único consumo de RNG); el resto es determinista.
- Desempate de centroide: primer `c` con distancia² estrictamente menor (sin cambios).
- Acumulación de medias en el MISMO orden (i ascendente, d ascendente) — sin reordenar floats.

## Examples
- 300 casos (datos agrupados, n/dim/k variados) + bordes (n=1, k>n, k=1): `_kmeans === oráculo`.
- `actualK = min(k, n)`.

## Do / Don't
- DO: extraer los pasos de Lloyd a helpers; preservar el orden de las operaciones.
- DON'T: reordenar las sumas (cambiaría el resultado en punto flotante); tocar el RNG.

## Tests
Property-test congelado (`test_kmeans.js`): oráculo INDEPENDIENTE (copia del `_kmeans` original)
con `Math.random` seedeado determinista; 4 bordes + 300 aleatorios con datos en clusters (fuerzan
iteración real). Asserta igualdad EXACTA de `{centroids, assignments}`.

## Constraints
- NO cambiar la matemática, el orden de acumulación ni el consumo del RNG.
- PARAR y reportar si bajar la complejidad exige alterar el resultado numérico.
