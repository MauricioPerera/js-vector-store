"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { lib, vec, populate } = require("./helpers.js");
const { VectorStore, QuantizedStore, BinaryQuantizedStore, MemoryStorageAdapter } = lib;

const DIM = 16;

for (const [name, Store] of [
  ["VectorStore", VectorStore],
  ["QuantizedStore", QuantizedStore],
  ["BinaryQuantizedStore", BinaryQuantizedStore],
]) {
  test(`${name}: persiste vía adapter y se recarga en un store nuevo`, () => {
    const adapter = new MemoryStorageAdapter();
    const a = new Store(adapter, DIM);
    const vecs = populate(a, 10, DIM);

    // Nuevo store sobre el MISMO adapter: los datos sobreviven.
    const b = new Store(adapter, DIM);
    assert.strictEqual(b.count("c"), 10, "count tras recargar");
    assert.ok(b.has("c", "id3"));
    // self-search sigue funcionando tras recargar
    const top = b.search("c", vecs[7], 3)[0];
    assert.strictEqual(top.id, "id7");
  });
}
