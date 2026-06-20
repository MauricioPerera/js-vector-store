---
task: matchfilter-dispatch-table
intent: "Resolver matchFilter con tablas de despacho de operadores."
target: ../../js-vector-store.js
signature: "function matchFilter(metadata, filter)"
budget: { cyclomatic_max: 8, nesting_max: 3, params_max: 2, lines_max: 20 }
deps_allowed: []
forbids: ["switch gigante por operador", "estado global", "mutar metadata"]
tests: test_matchfilter.js
test_command: node ccdd/15-matchfilter/test_matchfilter.js
language: javascript
issue: "MauricioPerera/js-vector-store#15"
require_test_approval: true
spec_version: "0.1"
tests_sha256: "0f342c018be019819046dae379769615b1d3c94bdd5d1e9032e0f2bd1666e8ce"
---

## Intent
Bajar `matchFilter` de CRÍTICA (ciclomática 44) a budget, reemplazando la cadena de `if` por
operador y el `switch` de comparadores por **tablas de despacho**, sin cambiar su comportamiento.
Éxito: pasa los property-tests congelados (equivalencia con el oráculo) y respeta el budget.

## Interface
```
in:  metadata: objeto (o falsy -> {}), filter: objeto de filtro (o falsy/no-objeto -> match)
out: boolean — true si metadata satisface filter
error: no lanza salvo $regex con patrón inválido (igual que la versión original)
```

## Invariants
- Operadores lógicos: `$and` (todos), `$or` (alguno), `$not` (negación); array inválido en
  `$and`/`$or` => no-match.
- Comparadores de campo: `$eq $ne $gt $gte $lt $lte $in $nin $exists $regex`; operador
  desconocido se ignora (como el `default` original).
- Igualdad simple cuando la condición no es objeto (`val === cond`).
- Función pura: no muta `metadata` ni `filter`.

## Examples
- `matchFilter({a:1}, {a:{$gt:0}})` -> `true`
- `matchFilter({a:2}, {$or:[{a:9},{a:2}]})` -> `true`
- `matchFilter({a:1}, {$not:{a:1}})` -> `false`
- `matchFilter({a:'hello'}, {a:{$regex:'^he'}})` -> `true`

## Do / Don't
- DO: `FILTER_COMPARATORS` y `FILTER_LOGICAL` como tablas; cada operador, función pequeña.
- DON'T: no reintroducir el `switch` gigante; no mutar `metadata`; no añadir dependencias.
- Patrón a imitar: despacho por clave en vez de cadena de condicionales.

## Tests
Property-test congelado (`test_matchfilter.js`): oráculo INDEPENDIENTE (copia de la semántica
original) vs la implementación, sobre 27 casos fijos por operador + 5000 aleatorios con semilla
fija. Asserta igualdad exacta de resultado en cada caso. Existe antes de refactorizar.

## Constraints
- NO cambiar la firma ni el contrato de `matchFilter` (mismas entradas/salidas).
- NO tocar nada fuera de `matchFilter` y sus helpers de despacho.
- PARAR y reportar si el budget no se puede cumplir sin cambiar el comportamiento observable.
