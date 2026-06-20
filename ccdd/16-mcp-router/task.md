---
task: api-server-resolve-route
intent: "Resolver la acción de una ruta del api-server según (method, pathname)."
target: ../../mcp-vector-store/api-routes.js
signature: "function resolveApiRoute(method, pathname)"
budget: { cyclomatic_max: 6, nesting_max: 2, params_max: 2, lines_max: 12 }
deps_allowed: []
forbids: ["cadena de if por ruta en el handler", "I/O", "estado global"]
tests: test_api_routes.js
test_command: node ../ccdd/16-mcp-router/test_api_routes.js
language: javascript
issue: "MauricioPerera/js-vector-store#16"
require_test_approval: true
spec_version: "0.1"
tests_sha256: "188e93e183217782e5d9f0d46f3ec86fc2bf2442cdb8cbe5d6730df6e94f73c6"
---

## Intent
Extraer el enrutado del api-server headless (hoy una cadena de `if` dentro del callback de
`createServer`, ciclomática 29) a un resolvedor PURO `resolveApiRoute(method, pathname)` + una
tabla de acciones de colección, separando QUÉ acción corre del manejo real (embeddings, store,
BM25). Éxito: reproduce el enrutado original y respeta el budget.

## Interface
```
in:  method: string (verbo HTTP), pathname: string (ruta sin query)
out: { action: string, colName?: string, docId?: string|null }
     action ∈ {health, list, index, search, getById, delete, methodNotAllowed, notFound}
error: no lanza
```

## Invariants
- Equivalencia exacta con la cadena de `if` del handler original (misma acción/colName/docId).
- `resolveApiRoute` es PURO: no toca red, filesystem ni estado global.
- `/health` y `/collections` resuelven sin importar el método; las rutas de colección
  dependen de método + presencia de `:id`.

## Examples
- `resolveApiRoute('GET', '/health')` -> `{ action: 'health' }`
- `resolveApiRoute('POST', '/collections/docs')` -> `{ action: 'index', colName: 'docs', docId: null }`
- `resolveApiRoute('GET', '/collections/docs/abc')` -> `{ action: 'getById', colName: 'docs', docId: 'abc' }`
- `resolveApiRoute('GET', '/unknown')` -> `{ action: 'notFound' }`

## Do / Don't
- DO: regex de colección + tabla de acciones; cada decisión, una unidad pequeña.
- DON'T: reintroducir la cadena de `if` en el handler; hacer I/O en el resolvedor.

## Tests
Property-test congelado (`test_api_routes.js`): oráculo INDEPENDIENTE que reproduce la cadena de
`if` original; 17 casos fijos (uno por acción + negativos) + 6000 combinaciones (method, pathname)
con semilla fija. Asserta igualdad de `{action, colName, docId}` en cada caso.

## Constraints
- NO cambiar la semántica de enrutado observable (mismas acciones/status que el original).
- PARAR y reportar si una ruta no se puede expresar como predicado puro sobre (method, pathname).
