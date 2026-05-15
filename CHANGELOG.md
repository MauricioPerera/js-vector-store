# Changelog

## 1.0.1 - 2026-05-15

### Fixed
- **Security**: Cloudflare Worker `server/src/index.js` now fails closed when `API_TOKEN` is empty or unset. All non-GET requests (except `GET /`) return 401 unless a valid Bearer token is provided.
- **MCP BM25 persistence**: `mcp-vector-store/vector-store-server.js` now loads persisted BM25 indexes on collection startup (`getCollection`), saves them on `persistStore()`, and indexes pre-computed vectors into BM25 when `metadata.text` is present (`vector_index`).

## 1.0.0 - 2026-05-05

### Added
- Initial release: `js-vector-store` core, Cloudflare Worker server, MCP server, Ollama embedding integration, BM25 + hybrid search, IVF clustering, and quantized backends (int8 / binary).
