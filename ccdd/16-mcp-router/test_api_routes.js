"use strict";
// Property-test CONGELADO de resolveApiRoute (issue #16). Oráculo INDEPENDIENTE: reproduce la
// cadena de if del handler ORIGINAL de vector-api-server.js (routing por pathname/método/:id).
// 17 casos fijos + 6000 combinaciones (method, pathname) con semilla fija. Sin red, sin I/O.

const { resolveApiRoute } = require("../../mcp-vector-store/api-routes.js");

// --- Oráculo: cadena de if del handler original (solo enrutado) ------------------------------
const RE = /^\/collections\/([^/]+)(?:\/([^/]+))?$/;
function oracle(method, pathname) {
  if (pathname === "/health") return { action: "health" };
  if (pathname === "/collections") return { action: "list" };
  const m = pathname.match(RE);
  if (!m) return { action: "notFound" };
  const colName = m[1];
  const docId = m[2] || null;
  let action;
  if (method === "POST" && !docId) action = "index";
  else if (method === "GET" && !docId) action = "search";
  else if (method === "GET" && docId) action = "getById";
  else if (method === "DELETE" && docId) action = "delete";
  else action = "methodNotAllowed";
  return { action, colName, docId };
}

let fail = 0;
function eq(a, b) {
  return a.action === b.action && (a.colName || null) === (b.colName || null) && (a.docId || null) === (b.docId || null);
}
function check(method, pathname, label) {
  const a = resolveApiRoute(method, pathname);
  const b = oracle(method, pathname);
  if (!eq(a, b)) {
    fail++;
    if (fail <= 15) console.error("DIVERGENCIA", label || "", method, pathname, "got", JSON.stringify(a), "oracle", JSON.stringify(b));
  }
}

// --- Casos fijos: una ruta por acción + negativos -------------------------------------------
const fixed = [
  ["GET", "/health"], ["POST", "/health"],
  ["GET", "/collections"], ["DELETE", "/collections"],
  ["POST", "/collections/docs"], ["GET", "/collections/docs"],
  ["GET", "/collections/docs/abc"], ["DELETE", "/collections/docs/abc"],
  ["PUT", "/collections/docs"], ["PUT", "/collections/docs/abc"], // methodNotAllowed
  ["POST", "/collections/docs/abc"],                              // methodNotAllowed (POST con id)
  ["DELETE", "/collections/docs"],                                // methodNotAllowed (DELETE sin id)
  ["GET", "/"], ["GET", "/unknown"], ["GET", "/collections/"],    // notFound
  ["GET", "/collections/a/b/c"], ["GET", "/collections/docs/x/"],
];
fixed.forEach(([m, p], i) => check(m, p, `fixed#${i}`));

// --- Aleatorio con semilla fija --------------------------------------------------------------
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(424242);
const pick = (a) => a[Math.floor(rand() * a.length)];
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"];
const SEG = ["health", "collections", "docs", "abc", "", "x", "v1", "foo"];

const N = 6000;
for (let i = 0; i < N; i++) {
  const len = Math.floor(rand() * 5);
  const pathname = "/" + Array.from({ length: len }, () => pick(SEG)).join("/");
  check(pick(METHODS), pathname, `rand#${i}`);
}

if (fail > 0) {
  console.error(`\nFAIL: ${fail} divergencias entre resolveApiRoute y el oráculo`);
  process.exit(1);
}
console.log(`OK: resolveApiRoute == oráculo en ${fixed.length} casos fijos + ${N} aleatorios`);
