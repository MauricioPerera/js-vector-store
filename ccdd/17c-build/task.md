---
task: ivf-build-dequantize
intent: "Reducir la complejidad de build extrayendo la dequantización a un helper."
target: ../../js-vector-store.js
signature: "build(col, sampleDims)"
budget: { cyclomatic_max: 8, nesting_max: 3, params_max: 2, lines_max: 25 }
deps_allowed: []
forbids: ["cadena else-if anidada", "estado global", "cambiar la dequantización"]
tests: test_build.js
test_command: node ccdd/17c-build/test_build.js
language: javascript
issue: "MauricioPerera/js-vector-store#17"
require_test_approval: true
spec_version: "0.1"
tests_sha256: "949ab7aba99378ee3248e296d6db22009e33da090298e139a9c8b8ee90aab856"
---

## Intent
`IVFIndex.build` tenía anidamiento 4 / ciclomática 13 por una cadena `if/else-if/else` con bucles
de dequantización por tipo de store. Extraer `_dequantizeFlat` (early-returns por tipo), bajando
build a complejidad baja sin cambiar el `flat` que alimenta a `_kmeans`.

> Parte de #17 (riesgo medio). El único cambio observable es estructural; el `flat` es idéntico.

## Interface
```
build(col, sampleDims=128) -> { numClusters, numVectors }   (firma y comportamiento sin cambios)
_dequantizeFlat(col, entry, n, dim) -> Float64Array(n*dim)  (dequantiza según el tipo de store)
```

## Invariants
- `_dequantizeFlat` produce un `flat` IDÉNTICO al de la dequantización inline original, para
  VectorStore (float32), QuantizedStore (int8) y Binary/PolarQuantizedStore.
- `build` mantiene firma, side-effects (escribe el índice, setea _indexes) y valor de retorno.
- El RNG de `_kmeans` no se toca; con la misma semilla, mismo índice.

## Examples
- VectorStore: `flat[i] = f32[i]`.
- QuantizedStore: `flat = ((int8+128)/255)*range + min` con `range = max-min || 1`.

## Do / Don't
- DO: early-returns por tipo de store en el helper; mantener la aritmética de dequantización.
- DON'T: reintroducir el else-if anidado; cambiar la fórmula de dequantización.

## Tests
Property-test congelado (`test_build.js`): equivalencia de `_dequantizeFlat` contra un oráculo
(copia de la lógica original) para los 3 tipos de store con datos sintéticos, más un smoke de
`build()` end-to-end (RNG seedeado): numVectors/numClusters y assignments por vector.

## Constraints
- NO cambiar la dequantización ni el contrato de `build`.
- PARAR y reportar si bajar el anidamiento exige alterar el `flat`.
