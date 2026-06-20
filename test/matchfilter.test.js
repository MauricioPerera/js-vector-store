"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { lib } = require("./helpers.js");
const { matchFilter } = lib;

test("matchFilter: igualdad simple y campos múltiples", () => {
  assert.strictEqual(matchFilter({ a: 1 }, { a: 1 }), true);
  assert.strictEqual(matchFilter({ a: 1 }, { a: 2 }), false);
  assert.strictEqual(matchFilter({ a: 1, b: 2 }, { a: 1, b: 2 }), true);
  assert.strictEqual(matchFilter({ a: 1, b: 2 }, { a: 1, b: 3 }), false);
});

test("matchFilter: comparadores", () => {
  assert.strictEqual(matchFilter({ a: 5 }, { a: { $gt: 3 } }), true);
  assert.strictEqual(matchFilter({ a: 5 }, { a: { $gte: 5 } }), true);
  assert.strictEqual(matchFilter({ a: 5 }, { a: { $lt: 5 } }), false);
  assert.strictEqual(matchFilter({ a: 5 }, { a: { $lte: 5 } }), true);
  assert.strictEqual(matchFilter({ a: 5 }, { a: { $ne: 4 } }), true);
  assert.strictEqual(matchFilter({ a: 2 }, { a: { $in: [1, 2, 3] } }), true);
  assert.strictEqual(matchFilter({ a: 9 }, { a: { $in: [1, 2, 3] } }), false);
  assert.strictEqual(matchFilter({ a: 2 }, { a: { $nin: [1, 3] } }), true);
});

test("matchFilter: $exists y $regex", () => {
  assert.strictEqual(matchFilter({ a: 1 }, { a: { $exists: true } }), true);
  assert.strictEqual(matchFilter({}, { a: { $exists: false } }), true);
  assert.strictEqual(matchFilter({}, { a: { $exists: true } }), false);
  assert.strictEqual(matchFilter({ name: "hello" }, { name: { $regex: "^he" } }), true);
  assert.strictEqual(matchFilter({ name: "world" }, { name: { $regex: "^he" } }), false);
});

test("matchFilter: operadores lógicos $and/$or/$not", () => {
  assert.strictEqual(matchFilter({ a: 1, b: 2 }, { $and: [{ a: 1 }, { b: { $gt: 1 } }] }), true);
  assert.strictEqual(matchFilter({ a: 1, b: 2 }, { $and: [{ a: 1 }, { b: { $gt: 5 } }] }), false);
  assert.strictEqual(matchFilter({ a: 9 }, { $or: [{ a: 1 }, { a: 9 }] }), true);
  assert.strictEqual(matchFilter({ a: 9 }, { $or: [{ a: 1 }, { a: 2 }] }), false);
  assert.strictEqual(matchFilter({ a: 1 }, { $not: { a: 2 } }), true);
  assert.strictEqual(matchFilter({ a: 1 }, { $not: { a: 1 } }), false);
});

test("matchFilter: filtro nulo/no-objeto -> match; array inválido en $and -> no match", () => {
  assert.strictEqual(matchFilter({ a: 1 }, null), true);
  assert.strictEqual(matchFilter({ a: 1 }, {}), true);
  assert.strictEqual(matchFilter({ a: 1 }, { $and: "no-array" }), false);
});
