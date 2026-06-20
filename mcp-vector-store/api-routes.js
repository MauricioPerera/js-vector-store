"use strict";
/**
 * api-routes.js — enrutado PURO del api-server headless. Mapea (method, pathname) -> acción.
 *
 * Separa QUÉ acción corre (testeable en node, sin I/O ni Ollama) del manejo real (embeddings,
 * store, BM25), que vive en vector-api-server.js. El servidor consume `resolveApiRoute`.
 */

const COLLECTION_RE = /^\/collections\/([^/]+)(?:\/([^/]+))?$/;

// Acción para una ruta de colección según método y presencia de :id. Unidad pequeña y pura.
function collectionAction(method, hasDocId) {
  if (method === "POST" && !hasDocId) return "index";
  if (method === "GET" && !hasDocId) return "search";
  if (method === "GET" && hasDocId) return "getById";
  if (method === "DELETE" && hasDocId) return "delete";
  return "methodNotAllowed";
}

// (method, pathname) -> { action, colName?, docId? }. Determinista, sin efectos.
function resolveApiRoute(method, pathname) {
  if (pathname === "/health") return { action: "health" };
  if (pathname === "/collections") return { action: "list" };
  const m = pathname.match(COLLECTION_RE);
  if (!m) return { action: "notFound" };
  const colName = m[1];
  const docId = m[2] || null;
  return { action: collectionAction(method, !!docId), colName, docId };
}

module.exports = { resolveApiRoute, collectionAction, COLLECTION_RE };
