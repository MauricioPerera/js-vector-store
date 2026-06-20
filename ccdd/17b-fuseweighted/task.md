---
task: fuse-weighted-normalize
intent: "Reducir la complejidad de _fuseWeighted extrayendo la normalización min-max."
target: ../../js-vector-store.js
signature: "_fuseWeighted(vecResults, bm25Scores, limit, vectorWeight, textWeight)"
budget: { cyclomatic_max: 8, nesting_max: 3, params_max: 5, lines_max: 30 }
deps_allowed: []
forbids: ["bucles min/max inline", "estado global", "cambiar la aritmética de fusión"]
tests: test_fuse.js
test_command: node ccdd/17b-fuseweighted/test_fuse.js
language: javascript
issue: "MauricioPerera/js-vector-store#17"
require_test_approval: true
spec_version: "0.1"
tests_sha256: "b027549d49cff97d26b4f1c253c7f63593bfd964f2ee451050378cc8b9d14341"
---

## Intent
`_fuseWeighted` (fusión híbrida weighted) tenía ciclomática 15 por los bucles min/max y los
ternarios de normalización inline. Extraer `scoreRange` (min/max/amplitud) y `normalizeScore`
(normalización a [0,1] con guardia de rango 0), bajando la complejidad sin cambiar el resultado.

> Parte de #17 (función numérica de riesgo medio). La equivalencia se prueba byte a byte.

## Interface
```
in:  vecResults: [{id, score, metadata}], bm25Scores: Map<id, score>, limit: int,
     vectorWeight: number, textWeight: number
out: top-`limit` fusionados [{id, score, metadata}] (score = vw*normVec + tw*normBm25, 6 decimales)
error: no lanza
```

## Invariants
- Resultado IDÉNTICO al original (misma aritmética, mismo orden de inserción/iteración).
- Normalización: `range > 0 ? (v-min)/range : 1.0` (rango 0 -> 1.0, como el original).
- Docs solo-vector: normBm25 = 0 si el id no está en bm25Scores.
- `scoreRange`/`normalizeScore` son puros (no mutan entradas).

## Examples
- scores de vector todos iguales (rango 0) -> normVec = 1.0 para todos.
- id en bm25 pero no en vector -> entry con score = textWeight * normBm25, metadata {}.

## Do / Don't
- DO: helpers `scoreRange`/`normalizeScore`; mantener el redondeo a 1e6 y el orden del heap.
- DON'T: cambiar el orden de fusión ni la fórmula del score.

## Tests
Property-test congelado (`test_fuse.js`): oráculo INDEPENDIENTE (copia de la lógica original);
8 casos fijos (vacíos, rango 0, ids solapados, pesos extremos, negativos) + 5000 aleatorios con
semilla fija. Asserta igualdad EXACTA del resultado (JSON) en cada caso.

## Constraints
- NO cambiar la semántica observable ni la aritmética en punto flotante.
- PARAR y reportar si bajar la complejidad exige alterar el resultado.
