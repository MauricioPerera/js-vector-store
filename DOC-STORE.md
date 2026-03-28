# js-doc-store

Document database en vanilla JS — zero dependencias. Corre en Node.js, browser, Cloudflare Workers, Deno, Bun.

Queries estilo MongoDB con indices, joins, aggregation, encriptacion y autenticacion. Un solo archivo.

## Instalacion

```bash
cp js-doc-store.js tu-proyecto/
```

```js
const {
  DocStore,
  MemoryStorageAdapter,
  FileStorageAdapter,
  CloudflareKVAdapter,
  EncryptedAdapter,
  FieldCrypto,
  Auth,
} = require('./js-doc-store');
```

## Quick Start

```js
const db = new DocStore(new MemoryStorageAdapter());
// o persistente: new DocStore('./data')
// o Cloudflare KV: new DocStore(new CloudflareKVAdapter(env.MY_KV))

const users = db.collection('users');
users.createIndex('email', { unique: true });

users.insert({ name: 'Alice', email: 'alice@test.com', age: 30 });
users.insert({ name: 'Bob', email: 'bob@test.com', age: 25 });

users.find({ age: { $gte: 18 } }).sort({ age: -1 }).limit(10).toArray();

db.flush(); // persiste a disco/KV
```

## CRUD

### Insert

```js
// Auto-genera _id
const doc = users.insert({ name: 'Alice', age: 30 });
// doc._id = 'lxyz123-abc-1'

// _id manual
users.insert({ _id: 'custom-id', name: 'Bob' });

// Batch
users.insertMany([{ name: 'C' }, { name: 'D' }]);
```

### Find

```js
users.findById('custom-id');
users.findOne({ email: 'alice@test.com' });

// Cursor (lazy — no ejecuta hasta toArray/first/count)
users.find({ age: { $gte: 18 } })
  .sort({ age: -1 })
  .skip(20)
  .limit(10)
  .project({ name: 1, age: 1 })
  .toArray();

users.find({ city: 'Madrid' }).first();
users.find({ active: true }).count();
```

### Update

```js
users.update({ email: 'x@test.com' }, { $set: { age: 31 } });
users.updateMany({ active: false }, { $set: { archived: true } });
```

### Remove

```js
users.remove({ email: 'x@test.com' });
users.removeMany({ archived: true });
users.removeById('custom-id');
```

### Count

```js
users.count();                          // total
users.count({ age: { $gte: 18 } });    // con filtro
```

## Query Operators

### Comparacion

| Operador | Ejemplo | Descripcion |
|---|---|---|
| igualdad | `{ name: 'Alice' }` | Campo es exactamente el valor |
| `$eq` | `{ age: { $eq: 30 } }` | Igual (explicito) |
| `$ne` | `{ status: { $ne: 'deleted' } }` | No igual |
| `$gt` | `{ age: { $gt: 18 } }` | Mayor que |
| `$gte` | `{ age: { $gte: 18 } }` | Mayor o igual |
| `$lt` | `{ price: { $lt: 100 } }` | Menor que |
| `$lte` | `{ price: { $lte: 100 } }` | Menor o igual |

### Set

| Operador | Ejemplo | Descripcion |
|---|---|---|
| `$in` | `{ status: { $in: ['active', 'pending'] } }` | Valor en lista |
| `$nin` | `{ role: { $nin: ['banned'] } }` | Valor NO en lista |

### Existencia y patron

| Operador | Ejemplo | Descripcion |
|---|---|---|
| `$exists` | `{ phone: { $exists: true } }` | Campo existe |
| `$regex` | `{ name: { $regex: '^Al' } }` | Match regex |
| `$contains` | `{ tags: { $contains: 'admin' } }` | Array contiene valor |
| `$size` | `{ tags: { $size: 3 } }` | Array tiene N elementos |

### Logicos

| Operador | Ejemplo | Descripcion |
|---|---|---|
| `$and` | `{ $and: [{ age: { $gte: 18 } }, { active: true }] }` | Todos deben cumplir |
| `$or` | `{ $or: [{ city: 'Madrid' }, { city: 'Barcelona' }] }` | Al menos uno cumple |
| `$not` | `{ $not: { status: 'deleted' } }` | Niega el filtro |

### Dot notation

```js
users.find({ 'address.city': 'Madrid' });
users.find({ 'profile.settings.theme': 'dark' });
```

## Update Operators

| Operador | Ejemplo | Efecto |
|---|---|---|
| `$set` | `{ $set: { name: 'Alice', age: 31 } }` | Setea campos |
| `$unset` | `{ $unset: { tempField: 1 } }` | Elimina campos |
| `$inc` | `{ $inc: { visits: 1, score: -5 } }` | Incrementa/decrementa |
| `$push` | `{ $push: { tags: 'new-tag' } }` | Agrega a array |
| `$pull` | `{ $pull: { tags: 'old-tag' } }` | Remueve de array |
| `$rename` | `{ $rename: { oldName: 'newName' } }` | Renombra campo |

## Indices

### Hash Index (igualdad O(1))

```js
users.createIndex('email', { unique: true });
users.createIndex('category');

// Las queries sobre campos indexados usan el indice automaticamente
users.findOne({ email: 'alice@test.com' }); // O(1) en vez de O(n)
```

### Sorted Index (rangos + ORDER BY)

```js
users.createIndex('age', { type: 'sorted' });

// Range queries usan binary search
users.find({ age: { $gte: 18, $lte: 65 } }).toArray();
```

### Gestion

```js
users.dropIndex('email');
users.getIndexes(); // [{ field, type, unique }]
```

## Aggregation Pipeline

```js
orders.aggregate()
  .match({ status: 'completed' })
  .lookup({ from: 'users', localField: 'userId', foreignField: '_id', as: 'user', single: true })
  .group('user.name', {
    total:    { $sum: 'price' },
    count:    { $count: true },
    avgPrice: { $avg: 'price' },
    minPrice: { $min: 'price' },
    maxPrice: { $max: 'price' },
  })
  .sort({ total: -1 })
  .limit(10)
  .toArray();
```

### Stages disponibles

| Stage | Descripcion |
|---|---|
| `.match(filter)` | Filtra documentos |
| `.lookup(opts)` | Join con otra coleccion |
| `.group(field, accumulators)` | Agrupa y calcula agregados |
| `.sort(spec)` | Ordena (`1` asc, `-1` desc) |
| `.limit(n)` | Limita resultados |
| `.skip(n)` | Salta N resultados |
| `.project(spec)` | Incluye/excluye campos |
| `.unwind(field)` | Desdobla arrays en documentos individuales |

### Accumulators para group

| Accumulator | Ejemplo | Resultado |
|---|---|---|
| `$count` | `{ total: { $count: true } }` | Cantidad de docs en el grupo |
| `$sum` | `{ revenue: { $sum: 'price' } }` | Suma del campo |
| `$avg` | `{ avgAge: { $avg: 'age' } }` | Promedio |
| `$min` | `{ cheapest: { $min: 'price' } }` | Minimo |
| `$max` | `{ highest: { $max: 'price' } }` | Maximo |
| `$push` | `{ names: { $push: 'name' } }` | Array con todos los valores |
| `$first` | `{ first: { $first: 'name' } }` | Primer valor del grupo |
| `$last` | `{ last: { $last: 'name' } }` | Ultimo valor del grupo |

### Lookup (joins)

```js
// One-to-one (single: true → un objeto, no array)
orders.aggregate()
  .lookup({ from: 'users', localField: 'userId', foreignField: '_id', as: 'user', single: true })
  .toArray();
// order.user = { _id: 'u1', name: 'Alice', ... }

// One-to-many (default → array)
users.aggregate()
  .lookup({ from: 'orders', localField: '_id', foreignField: 'userId', as: 'orders' })
  .toArray();
// user.orders = [{ product: 'GPU', ... }, { product: 'RAM', ... }]

// Con filtro
users.aggregate()
  .lookup({
    from: 'orders',
    localField: '_id',
    foreignField: 'userId',
    as: 'bigOrders',
    filter: { price: { $gt: 100 } }
  })
  .toArray();

// Double lookup (orders + user + product)
orders.aggregate()
  .lookup({ from: 'users', localField: 'userId', foreignField: '_id', as: 'user', single: true })
  .lookup({ from: 'products', localField: 'productId', foreignField: '_id', as: 'product', single: true })
  .match({ 'product.category': 'hardware' })
  .toArray();
```

## Encriptacion

### Full database (at-rest)

```js
const adapter = await EncryptedAdapter.create(
  new FileStorageAdapter('./data'),
  'my-password'
);
const db = new DocStore(adapter);
// Todo se encripta con AES-256-GCM automaticamente

db.flush();
await adapter.persist(); // escribe encriptado a disco

// Para leer: preload primero
const adapter2 = await EncryptedAdapter.create(innerAdapter, 'my-password');
await adapter2.preload(['users.docs.json', 'users.meta.json']);
const db2 = new DocStore(adapter2);
```

### Field-level (campos individuales)

```js
const fc = await FieldCrypto.create('my-password');

users.insert({
  name: 'Alice',                              // queryable, indexable
  city: 'Madrid',                             // queryable, indexable
  ssn: await fc.encrypt('123-45-6789'),       // encriptado
  creditCard: await fc.encrypt('4111-...'),   // encriptado
});

// Leer campo encriptado
const doc = users.findOne({ name: 'Alice' });
const ssn = await fc.decrypt(doc.ssn); // '123-45-6789'

// Verificar si esta encriptado
fc.isEncrypted(doc.ssn);        // true
fc.isEncrypted(doc.name);       // false
```

## Autenticacion

```js
const auth = new Auth(db, { secret: 'jwt-secret-key' });
await auth.init();
```

### Registro y login

```js
const user = await auth.register('alice@test.com', 'password123', { name: 'Alice' });
const { token, user } = await auth.login('alice@test.com', 'password123');
```

### Verificar token

```js
const payload = await auth.verify(token);
// { sub: 'user-id', email: 'alice@test.com', roles: ['user'], exp: ... }
// null si invalido o expirado
```

### RBAC

```js
auth.assignRole(userId, 'admin');
auth.removeRole(userId, 'admin');
auth.hasRole(userId, 'admin');

// Verificar token + rol en una llamada
const payload = await auth.authorize(token, 'admin');
// payload si autorizado, null si no
```

### Gestion de usuarios

```js
auth.getUser(userId);
auth.getUserByEmail('alice@test.com');
auth.listUsers({ roles: { $contains: 'admin' } }, { sort: { createdAt: -1 }, limit: 10 });
auth.disableUser(userId);    // no puede hacer login
auth.enableUser(userId);
auth.deleteUser(userId);     // elimina user + sessions
```

### Passwords y sesiones

```js
await auth.changePassword(userId, 'old-pass', 'new-pass');
await auth.resetPassword(userId, 'new-pass');  // admin/recovery
auth.logout(token);                            // invalida sesion
auth.logoutAll(userId);                        // invalida todas las sesiones
auth.cleanExpiredSessions();                   // limpieza
```

## Storage Adapters

```js
// Node.js (disco)
new DocStore('./data');
new DocStore(new FileStorageAdapter('./data'));

// Memoria (tests, browser)
new DocStore(new MemoryStorageAdapter());

// Cloudflare Workers KV
const adapter = new CloudflareKVAdapter(env.MY_KV, 'prefix/');
await adapter.preload(['users.docs.json', 'users.meta.json']);
new DocStore(adapter);
// despues: db.flush(); await adapter.persist();

// Encriptado (wraps any adapter)
const adapter = await EncryptedAdapter.create(innerAdapter, 'password');
new DocStore(adapter);

// Custom (implementar 3 metodos):
class MyAdapter {
  readJson(filename)         { /* → object | null */ }
  writeJson(filename, data)  { /* object → void  */ }
  delete(filename)           { /* void            */ }
}
```

## Archivos de storage

```
Coleccion "users"
├── users.docs.json         Documentos: [{ _id, name, age, ... }]
├── users.meta.json         Metadata: { indexes: [{ field, type, unique }] }
├── users.email.idx.json    Hash index (si existe)
└── users.age.sidx.json     Sorted index (si existe)
```

## Equivalencias SQL

| SQL | js-doc-store |
|---|---|
| `SELECT * FROM users WHERE age > 18` | `users.find({ age: { $gt: 18 } }).toArray()` |
| `SELECT name, age FROM users ORDER BY age DESC LIMIT 10` | `users.find({}).sort({ age: -1 }).limit(10).project({ name: 1, age: 1 }).toArray()` |
| `SELECT COUNT(*) FROM users WHERE city = 'Madrid'` | `users.count({ city: 'Madrid' })` |
| `UPDATE users SET age = 31 WHERE email = 'x'` | `users.update({ email: 'x' }, { $set: { age: 31 } })` |
| `DELETE FROM users WHERE status = 'inactive'` | `users.removeMany({ status: 'inactive' })` |
| `SELECT u.name, SUM(o.price) FROM orders o JOIN users u ON o.userId = u._id GROUP BY u.name` | `orders.aggregate().lookup({ from: 'users', localField: 'userId', foreignField: '_id', as: 'user', single: true }).group('user.name', { total: { $sum: 'price' } }).toArray()` |
| `CREATE UNIQUE INDEX idx ON users(email)` | `users.createIndex('email', { unique: true })` |

## Licencia

MIT
