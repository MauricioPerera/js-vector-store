/**
 * Test suite para js-doc-store
 */

const {
  DocStore,
  MemoryStorageAdapter,
  matchFilter,
  applyUpdate,
} = require('./js-doc-store');

let passed = 0, failed = 0;
function assert(label, cond) {
  if (cond) { passed++; }
  else { failed++; console.log(`  FAIL: ${label}`); }
}

function section(name) { console.log(`\n${name}\n`); }

// ─── 1. CRUD basico ───────────────────────────────────────

section('1. CRUD BASICO');

const db = new DocStore(new MemoryStorageAdapter());
const users = db.collection('users');

// Insert
const alice = users.insert({ name: 'Alice', age: 30, city: 'Madrid', tags: ['admin', 'dev'] });
assert('insert returns doc with _id', !!alice._id);
assert('insert preserves fields', alice.name === 'Alice' && alice.age === 30);

const bob = users.insert({ _id: 'bob-id', name: 'Bob', age: 25, city: 'Barcelona', tags: ['dev'] });
assert('insert with custom _id', bob._id === 'bob-id');

users.insert({ name: 'Charlie', age: 35, city: 'Madrid', tags: ['ops'] });
users.insert({ name: 'Diana', age: 28, city: 'Valencia', tags: ['dev', 'ops'] });
users.insert({ name: 'Eve', age: 22, city: 'Barcelona', tags: ['intern'] });

assert('count = 5', users.count() === 5);

// Duplicate _id
let dupError = false;
try { users.insert({ _id: 'bob-id', name: 'Dup' }); } catch { dupError = true; }
assert('duplicate _id throws', dupError);

// FindById
const found = users.findById('bob-id');
assert('findById returns doc', found && found.name === 'Bob');
assert('findById returns copy', found !== bob);

const notFound = users.findById('nonexistent');
assert('findById returns null for missing', notFound === null);

// FindOne
const oneResult = users.findOne({ name: 'Alice' });
assert('findOne by name', oneResult && oneResult.name === 'Alice');

const noResult = users.findOne({ name: 'Zorro' });
assert('findOne returns null', noResult === null);

// InsertMany
const batch = users.insertMany([
  { name: 'Frank', age: 40, city: 'Madrid', tags: [] },
  { name: 'Grace', age: 33, city: 'Valencia', tags: ['dev'] },
]);
assert('insertMany returns array', batch.length === 2);
assert('count after insertMany = 7', users.count() === 7);

// ─── 2. QUERIES con find() ───────────────────────────────

section('2. QUERIES (find + cursor)');

// Simple equality
let results = users.find({ city: 'Madrid' }).toArray();
assert('find by city Madrid = 3', results.length === 3);

// Comparison
results = users.find({ age: { $gte: 30 } }).toArray();
assert('find age >= 30', results.length === 4);
assert('all >= 30', results.every(r => r.age >= 30));

results = users.find({ age: { $gt: 25, $lt: 35 } }).toArray();
assert('find 25 < age < 35', results.every(r => r.age > 25 && r.age < 35));

// $in
results = users.find({ city: { $in: ['Madrid', 'Valencia'] } }).toArray();
assert('$in cities', results.every(r => ['Madrid', 'Valencia'].includes(r.city)));

// $regex
results = users.find({ name: { $regex: '^[A-D]' } }).toArray();
assert('$regex A-D names', results.every(r => /^[A-D]/.test(r.name)));

// $or
results = users.find({ $or: [{ city: 'Madrid' }, { age: { $lt: 25 } }] }).toArray();
assert('$or Madrid or age<25', results.length >= 3);

// $and
results = users.find({ $and: [{ city: 'Madrid' }, { age: { $gte: 35 } }] }).toArray();
assert('$and Madrid + age>=35', results.every(r => r.city === 'Madrid' && r.age >= 35));

// $not
results = users.find({ $not: { city: 'Madrid' } }).toArray();
assert('$not Madrid', results.every(r => r.city !== 'Madrid'));

// $exists
results = users.find({ tags: { $exists: true } }).toArray();
assert('$exists tags', results.length === 7);

// $contains (array element)
results = users.find({ tags: { $contains: 'dev' } }).toArray();
assert('$contains dev', results.length >= 3);

// Nested dot notation
users.insert({ _id: 'nested', name: 'Hans', age: 45, city: 'Berlin', address: { zip: '10115', country: 'DE' }, tags: [] });
const nested = users.findOne({ 'address.country': 'DE' });
assert('dot notation query', nested && nested.name === 'Hans');

// ─── 3. CURSOR (sort, skip, limit, project) ──────────────

section('3. CURSOR');

results = users.find({}).sort({ age: 1 }).toArray();
assert('sort asc', results[0].age <= results[1].age);

results = users.find({}).sort({ age: -1 }).toArray();
assert('sort desc', results[0].age >= results[1].age);

results = users.find({}).sort({ age: 1 }).skip(2).limit(3).toArray();
assert('skip+limit count=3', results.length === 3);

results = users.find({}).project({ name: 1, age: 1 }).toArray();
assert('project include', results.every(r => r.name && r.age && !r.city));

results = users.find({}).project({ tags: 0 }).toArray();
assert('project exclude', results.every(r => r.tags === undefined && r.name));

// Cursor .first()
const first = users.find({ city: 'Madrid' }).sort({ age: -1 }).first();
assert('cursor .first()', first && first.city === 'Madrid');

// Cursor .count()
const cnt = users.find({ city: 'Madrid' }).count();
assert('cursor .count()', cnt === 3);

// ─── 4. INDICES ──────────────────────────────────────────

section('4. INDICES');

// Hash index
users.createIndex('city');
results = users.find({ city: 'Madrid' }).toArray();
assert('hash index lookup', results.length === 3);

// Unique index
users.createIndex('name', { unique: true });
let uniqueErr = false;
try { users.insert({ name: 'Alice', age: 99, city: 'X', tags: [] }); } catch { uniqueErr = true; }
assert('unique constraint prevents dup', uniqueErr);

// Sorted index
users.createIndex('age', { type: 'sorted' });
results = users.find({ age: { $gte: 25, $lte: 35 } }).toArray();
assert('sorted index range query', results.every(r => r.age >= 25 && r.age <= 35));

// Drop index
users.dropIndex('city');
results = users.find({ city: 'Madrid' }).toArray();
assert('works after drop index (scan)', results.length === 3);

// Index list
const indexes = users.getIndexes();
assert('getIndexes returns defs', indexes.length === 2); // name + age

// ─── 5. UPDATE ───────────────────────────────────────────

section('5. UPDATE');

// $set
users.update({ name: 'Alice' }, { $set: { age: 31, role: 'lead' } });
const updated = users.findOne({ name: 'Alice' });
assert('$set age', updated.age === 31);
assert('$set new field', updated.role === 'lead');

// $inc
users.update({ name: 'Bob' }, { $inc: { age: 1 } });
assert('$inc', users.findOne({ name: 'Bob' }).age === 26);

// $push
users.update({ name: 'Bob' }, { $push: { tags: 'senior' } });
assert('$push', users.findOne({ name: 'Bob' }).tags.includes('senior'));

// $pull
users.update({ name: 'Bob' }, { $pull: { tags: 'dev' } });
assert('$pull', !users.findOne({ name: 'Bob' }).tags.includes('dev'));

// $unset
users.update({ name: 'Alice' }, { $unset: { role: 1 } });
assert('$unset', users.findOne({ name: 'Alice' }).role === undefined);

// $rename
users.update({ name: 'Charlie' }, { $rename: { city: 'location' } });
const charlie = users.findOne({ name: 'Charlie' });
assert('$rename', charlie.location === 'Madrid' && charlie.city === undefined);

// updateMany
const manyCount = users.updateMany({ city: 'Barcelona' }, { $set: { country: 'ES' } });
assert('updateMany count', manyCount === 2);
const bcn = users.find({ city: 'Barcelona' }).toArray();
assert('updateMany applied', bcn.every(r => r.country === 'ES'));

// ─── 6. REMOVE ───────────────────────────────────────────

section('6. REMOVE');

const beforeCount = users.count();
users.remove({ name: 'Eve' });
assert('remove one', users.count() === beforeCount - 1);
assert('removed doc gone', !users.findOne({ name: 'Eve' }));

users.insert({ name: 'Temp1', age: 99, city: 'X', tags: [] });
users.insert({ name: 'Temp2', age: 99, city: 'X', tags: [] });
const rmCount = users.removeMany({ age: 99 });
assert('removeMany removed 2', rmCount === 2);

users.removeById('nested');
assert('removeById', !users.findById('nested'));

// ─── 7. AGGREGATION ─────────────────────────────────────

section('7. AGGREGATION');

// Fresh data
const db2 = new DocStore(new MemoryStorageAdapter());
const orders = db2.collection('orders');

const orderData = [
  { customer: 'Alice', product: 'GPU',    price: 500, qty: 1, category: 'hardware' },
  { customer: 'Alice', product: 'RAM',    price: 100, qty: 4, category: 'hardware' },
  { customer: 'Bob',   product: 'IDE',    price: 50,  qty: 1, category: 'software' },
  { customer: 'Bob',   product: 'Editor', price: 30,  qty: 2, category: 'software' },
  { customer: 'Charlie', product: 'GPU',  price: 500, qty: 2, category: 'hardware' },
  { customer: 'Charlie', product: 'SSD',  price: 80,  qty: 3, category: 'hardware' },
];
orders.insertMany(orderData);

// Group by customer
let agg = orders.aggregate()
  .group('customer', {
    total: { $sum: 'price' },
    count: { $count: true },
    avgPrice: { $avg: 'price' },
  })
  .sort({ total: -1 })
  .toArray();

assert('group by customer', agg.length === 3);
assert('Alice total = 600', agg.find(r => r._id === 'Alice').total === 600);
assert('sorted by total desc', agg[0].total >= agg[1].total);

// Match + group
agg = orders.aggregate()
  .match({ category: 'hardware' })
  .group('customer', { spent: { $sum: 'price' } })
  .toArray();
assert('match+group hardware', agg.every(r => r.spent > 0));
assert('Bob not in hardware', !agg.find(r => r._id === 'Bob'));

// Group with min/max
agg = orders.aggregate()
  .group('category', {
    minPrice: { $min: 'price' },
    maxPrice: { $max: 'price' },
  })
  .toArray();
const hw = agg.find(r => r._id === 'hardware');
assert('min hardware = 80', hw.minPrice === 80);
assert('max hardware = 500', hw.maxPrice === 500);

// Limit
agg = orders.aggregate().group('customer', { c: { $count: true } }).limit(2).toArray();
assert('agg limit', agg.length === 2);

// Unwind
const db3 = new DocStore(new MemoryStorageAdapter());
const posts = db3.collection('posts');
posts.insert({ title: 'Post 1', tags: ['js', 'node'] });
posts.insert({ title: 'Post 2', tags: ['python', 'ml'] });

agg = posts.aggregate()
  .unwind('tags')
  .group('tags', { count: { $count: true } })
  .sort({ count: -1 })
  .toArray();
assert('unwind tags', agg.length === 4);
assert('each tag count=1', agg.every(r => r.count === 1));

// ─── 8. PERSISTENCE ─────────────────────────────────────

section('8. PERSISTENCE');

const adapter = new MemoryStorageAdapter();
const dbA = new DocStore(adapter);
const colA = dbA.collection('persist');
colA.createIndex('email', { unique: true });
colA.createIndex('age', { type: 'sorted' });
colA.insert({ name: 'Test1', email: 't1@test.com', age: 25 });
colA.insert({ name: 'Test2', email: 't2@test.com', age: 30 });
dbA.flush();

// Reload from same adapter (simulating restart)
const dbB = new DocStore(adapter);
const colB = dbB.collection('persist');
assert('persist count', colB.count() === 2);
assert('persist findOne', colB.findOne({ email: 't1@test.com' })?.name === 'Test1');

// Index survives reload
const idxes = colB.getIndexes();
assert('persist indexes', idxes.length === 2);

// Unique still enforced after reload
let persistUniqueErr = false;
try { colB.insert({ name: 'Dup', email: 't1@test.com', age: 99 }); } catch { persistUniqueErr = true; }
assert('persist unique enforced', persistUniqueErr);

// Sorted index works after reload
const sorted = colB.find({ age: { $gte: 28 } }).toArray();
assert('persist sorted index', sorted.length === 1 && sorted[0].name === 'Test2');

// ─── 9. EDGE CASES ─────────────────────────────────────

section('9. EDGE CASES');

const edge = new DocStore(new MemoryStorageAdapter());
const ec = edge.collection('edge');

// Empty collection queries
assert('empty count = 0', ec.count() === 0);
assert('empty find = []', ec.find({}).toArray().length === 0);
assert('empty findOne = null', ec.findOne({ x: 1 }) === null);
assert('empty aggregate = []', ec.aggregate().group('x', { c: { $count: true } }).toArray().length === 0);

// Remove from empty
assert('remove from empty = 0', ec.remove({ x: 1 }) === 0);

// Update nonexistent
assert('update nonexistent = 0', ec.update({ x: 1 }, { $set: { y: 2 } }) === 0);

// Drop collection
const dropDb = new DocStore(new MemoryStorageAdapter());
const dc = dropDb.collection('todrop');
dc.insert({ x: 1 });
dropDb.drop('todrop');
assert('drop removes collection', !dropDb.collections().includes('todrop'));

// ─── Summary ─────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`PASSED: ${passed}  FAILED: ${failed}`);
if (failed > 0) process.exit(1);
