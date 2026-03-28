/**
 * VercelBlobAdapter
 * Storage adapter for js-vector-store and js-doc-store on Vercel Blob.
 * Zero deps beyond @vercel/blob (which is already in your Vercel project).
 *
 * Uso:
 *   import { put, get, head, del, list } from '@vercel/blob';
 *   import { VercelBlobAdapter } from './vercel-blob-adapter';
 *
 *   const adapter = new VercelBlobAdapter({ put, get, head, del, list }, {
 *     prefix: 'myapp/',        // opcional: prefijo para organizar blobs
 *     access: 'private',       // 'private' o 'public'
 *     token: process.env.BLOB_READ_WRITE_TOKEN, // opcional si ya esta en env
 *   });
 *
 *   // Precargar datos existentes (inicio del request)
 *   await adapter.preload(['docs.bin', 'docs.json']);
 *
 *   // Usar con cualquier store
 *   const store = new VectorStore(adapter, 768);
 *   const db = new DocStore(adapter);
 *
 *   // Operaciones sync (desde cache)
 *   store.search('docs', queryVec, 5);
 *   db.collection('users').find({ active: true }).toArray();
 *
 *   // Persistir (fin del request)
 *   store.flush();
 *   db.flush();
 *   await adapter.persist();
 */

class VercelBlobAdapter {
  /**
   * @param {object} blob  Funciones de @vercel/blob: { put, get, head, del, list }
   * @param {object} [opts]
   * @param {string} [opts.prefix='']      Prefijo para pathnames
   * @param {string} [opts.access='private'] 'private' o 'public'
   * @param {string} [opts.token]          BLOB_READ_WRITE_TOKEN (opcional)
   */
  constructor(blob, opts = {}) {
    this._put  = blob.put;
    this._get  = blob.get;
    this._head = blob.head;
    this._del  = blob.del;
    this._list = blob.list;
    this.prefix = opts.prefix || '';
    this.access = opts.access || 'private';
    this.token  = opts.token || undefined;

    // Cache en memoria: filename → { data, url, type: 'json'|'bin', dirty }
    this._cache  = new Map();
    // URL mapping: filename → blob URL (necesario para get/del)
    this._urlMap = new Map();
  }

  _pathname(filename) { return this.prefix + filename; }

  _putOpts() {
    const opts = {
      access: this.access,
      addRandomSuffix: false,
      allowOverwrite: true,
    };
    if (this.token) opts.token = this.token;
    return opts;
  }

  _getOpts() {
    return this.token ? { token: this.token } : {};
  }

  /**
   * Descubre las URLs de blobs existentes para los filenames dados.
   * Vercel Blob necesita la URL completa para get/del, no solo el pathname.
   */
  async _resolveUrls(filenames) {
    // List all blobs with our prefix
    const toResolve = filenames.filter(f => !this._urlMap.has(f));
    if (toResolve.length === 0) return;

    const listOpts = { prefix: this.prefix, limit: 1000 };
    if (this.token) listOpts.token = this.token;

    let cursor;
    do {
      const result = await this._list({ ...listOpts, cursor });
      for (const blob of result.blobs) {
        // blob.pathname = 'prefix/filename'
        const filename = blob.pathname.startsWith(this.prefix)
          ? blob.pathname.slice(this.prefix.length)
          : blob.pathname;
        this._urlMap.set(filename, blob.url);
      }
      cursor = result.cursor;
    } while (cursor);
  }

  /**
   * Precarga archivos desde Vercel Blob a la cache en memoria.
   * Llamar al inicio del request.
   * @param {string[]} filenames  Ej: ['docs.bin', 'docs.json']
   */
  async preload(filenames) {
    await this._resolveUrls(filenames);

    const promises = filenames.map(async (f) => {
      const url = this._urlMap.get(f);
      if (!url) return;

      try {
        const response = await this._get(url, this._getOpts());
        if (!response) return;

        if (f.endsWith('.json')) {
          const data = await response.json();
          this._cache.set(f, { data, url, type: 'json', dirty: false });
        } else {
          const arrayBuffer = await response.arrayBuffer();
          this._cache.set(f, { data: arrayBuffer, url, type: 'bin', dirty: false });
        }
      } catch {
        // Blob no existe o error de red — skip
      }
    });

    await Promise.all(promises);
  }

  // ── Sync interface (desde cache) ──────────────────────

  readBin(filename) {
    const entry = this._cache.get(filename);
    return entry && entry.type === 'bin' ? entry.data : null;
  }

  writeBin(filename, buffer) {
    const url = this._urlMap.get(filename) || null;
    this._cache.set(filename, { data: buffer, url, type: 'bin', dirty: true });
  }

  readJson(filename) {
    const entry = this._cache.get(filename);
    return entry && entry.type === 'json' ? entry.data : null;
  }

  writeJson(filename, data) {
    const url = this._urlMap.get(filename) || null;
    this._cache.set(filename, { data, url, type: 'json', dirty: true });
  }

  delete(filename) {
    this._cache.delete(filename);
    // Mark for deletion on persist
    if (!this._pendingDeletes) this._pendingDeletes = [];
    const url = this._urlMap.get(filename);
    if (url) this._pendingDeletes.push(url);
    this._urlMap.delete(filename);
  }

  // ── Async persistence ─────────────────────────────────

  /**
   * Persiste todos los cambios a Vercel Blob.
   * Llamar despues de store.flush() / db.flush().
   */
  async persist() {
    const promises = [];

    // Uploads
    for (const [filename, entry] of this._cache) {
      if (!entry.dirty) continue;

      const pathname = this._pathname(filename);
      const opts = this._putOpts();

      if (entry.type === 'json') {
        opts.contentType = 'application/json';
        promises.push(
          this._put(pathname, JSON.stringify(entry.data), opts).then(result => {
            this._urlMap.set(filename, result.url);
            entry.url = result.url;
            entry.dirty = false;
          })
        );
      } else {
        opts.contentType = 'application/octet-stream';
        promises.push(
          this._put(pathname, entry.data, opts).then(result => {
            this._urlMap.set(filename, result.url);
            entry.url = result.url;
            entry.dirty = false;
          })
        );
      }
    }

    // Deletes
    if (this._pendingDeletes && this._pendingDeletes.length > 0) {
      const delOpts = this.token ? { token: this.token } : {};
      promises.push(
        this._del(this._pendingDeletes, delOpts).then(() => {
          this._pendingDeletes = [];
        })
      );
    }

    await Promise.all(promises);
  }
}

// Export for both CJS and ESM
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VercelBlobAdapter };
}
if (typeof globalThis !== 'undefined') {
  globalThis.VercelBlobAdapter = VercelBlobAdapter;
}
