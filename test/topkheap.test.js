"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { lib } = require("./helpers.js");
const { TopKHeap } = lib;

test("TopKHeap: conserva los k mayores por score, ordenados desc", () => {
  const heap = new TopKHeap(3);
  for (const s of [5, 1, 9, 3, 7, 2, 8]) heap.push({ id: "s" + s, score: s });
  const out = heap.sorted();
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((x) => x.score), [9, 8, 7]);
});

test("TopKHeap: menos de k elementos -> todos, ordenados", () => {
  const heap = new TopKHeap(5);
  for (const s of [2, 4, 1]) heap.push({ id: "s" + s, score: s });
  assert.deepStrictEqual(heap.sorted().map((x) => x.score), [4, 2, 1]);
});

test("TopKHeap: k=1 -> solo el máximo", () => {
  const heap = new TopKHeap(1);
  for (const s of [3, 10, 7]) heap.push({ score: s });
  assert.deepStrictEqual(heap.sorted().map((x) => x.score), [10]);
});
