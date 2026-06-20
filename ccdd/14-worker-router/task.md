---
task: worker-resolve-route
intent: "Resolver el handler de una ruta del worker según (method, parts)."
target: ../../server/src/routes.js
signature: "function resolveRoute(method, parts)"
budget: { cyclomatic_max: 6, nesting_max: 2, params_max: 2, lines_max: 12 }
deps_allowed: []
forbids: ["cadena de if por ruta", "acceso a env/KV", "estado global"]
tests: test_routes.js
test_command: node ../../ccdd/14-worker-router/test_routes.js
language: javascript
issue: "MauricioPerera/js-vector-store#14"
require_test_approval: true
spec_version: "0.1"
tests_sha256: "7e11a534fbdab53fb026d26050c4d042eea9b664a17f4b4bd00c4d0b909c6a59"
---

## Intent
Extraer el enrutado del Worker (hoy una cadena de ~17 `if` dentro de `fetch()`, ciclomática 97)
a una **tabla de rutas declarativa** + un resolvedor PURO `resolveRoute(method, parts)`, separando
QUÉ handler corre (testeable en node) del manejo real (I/O contra KV). Éxito: `resolveRoute`
reproduce exactamente el enrutado original y respeta el budget.

## Interface
```
in:  method: string (verbo HTTP), parts: string[] (segmentos del path sin barras extremas)
out: string (nombre de handler) | null (ninguna ruta casa -> 404)
error: no lanza
```

## Invariants
- Equivalencia exacta con la cadena de `if` original (mismo handler/null para cada method+parts).
- La raíz `/` resuelve a `root` con CUALQUIER método (fiel al original).
- `resolveRoute` es PURO: no toca `env`/KV ni estado global.
- Orden de la tabla = prioridad; predicados de match mutuamente excluyentes donde aplica.

## Examples
- `resolveRoute('GET', ['v1','stats'])` -> `'stats'`
- `resolveRoute('POST', ['v1','rerank'])` -> `'rerank'`
- `resolveRoute('DELETE', ['v1','collections','c','vectors','id1'])` -> `'deleteVector'`
- `resolveRoute('GET', ['v1','unknown'])` -> `null`

## Do / Don't
- DO: tabla `ROUTES` declarativa + bucle de resolución; cada `match` una función pequeña.
- DON'T: reintroducir la cadena de `if`; acceder a env/KV desde el resolvedor.

## Tests
Property-test congelado (`test_routes.js`): oráculo INDEPENDIENTE que reproduce la cadena de `if`
del `fetch()` original; 24 casos fijos (uno por handler + negativos) + 8000 combinaciones
(method, parts) con semilla fija. Asserta `resolveRoute === oráculo` en cada caso.

## Constraints
- NO cambiar la semántica de enrutado observable (mismos status/handlers que el original).
- PARAR y reportar si una ruta no se puede expresar como predicado puro sobre (method, parts).
