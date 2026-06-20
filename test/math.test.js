"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { lib, vec } = require("./helpers.js");
const { normalize, cosineSim, euclideanDist, dotProduct, manhattanDist, computeScore } = lib;

test("normalize: vector unitario (norma ~1)", () => {
  const u = normalize(vec(1, 16));
  let norm = 0;
  for (const x of u) norm += x * x;
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-6, `norma=${Math.sqrt(norm)}`);
});

test("normalize: vector cero queda cero", () => {
  const z = normalize(new Float32Array(8));
  assert.ok(z.every((x) => x === 0));
});

test("cosineSim: idéntico = 1, opuesto = -1", () => {
  const a = normalize(vec(2, 8));
  assert.ok(Math.abs(cosineSim(a, a) - 1) < 1e-6);
  const neg = a.map((x) => -x);
  assert.ok(Math.abs(cosineSim(a, neg) + 1) < 1e-6);
});

test("cosineSim: ortogonales ~ 0", () => {
  const a = normalize([1, 0, 0, 0]);
  const b = normalize([0, 1, 0, 0]);
  assert.ok(Math.abs(cosineSim(a, b)) < 1e-6);
});

test("euclideanDist: 0 consigo mismo, positiva entre distintos", () => {
  const a = vec(3, 8);
  assert.strictEqual(euclideanDist(a, a), 0);
  assert.ok(euclideanDist(a, vec(4, 8)) > 0);
});

test("dotProduct y manhattanDist: valores conocidos", () => {
  assert.strictEqual(dotProduct([1, 2, 3], [4, 5, 6]), 32);
  assert.strictEqual(manhattanDist([1, 2, 3], [4, 6, 8]), 3 + 4 + 5);
});

test("computeScore: coherente con la métrica (mayor score = más cercano)", () => {
  const q = normalize(vec(5, 8));
  const near = q;
  const far = normalize(q.map((x) => -x));
  for (const metric of ["cosine", "euclidean", "dot", "manhattan"]) {
    const sNear = computeScore(q, near, q.length, metric);
    const sFar = computeScore(q, far, q.length, metric);
    assert.ok(sNear >= sFar, `${metric}: near(${sNear}) >= far(${sFar})`);
  }
});
