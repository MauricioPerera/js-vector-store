"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { lib } = require("./helpers.js");
const { MemoryStorageAdapter, FileStorageAdapter } = lib;

test("MemoryStorageAdapter: bin/json round-trip + delete", () => {
  const a = new MemoryStorageAdapter();
  assert.strictEqual(a.readBin("x"), null);
  const buf = new Uint8Array([1, 2, 3]).buffer;
  a.writeBin("x", buf);
  a.writeJson("m", { a: 1 });
  assert.deepStrictEqual(new Uint8Array(a.readBin("x")), new Uint8Array([1, 2, 3]));
  assert.deepStrictEqual(a.readJson("m"), { a: 1 });
  a.delete("x");
  assert.strictEqual(a.readBin("x"), null);
});

test("FileStorageAdapter: persiste a disco (bin/json) y borra", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jvs-test-"));
  try {
    const a = new FileStorageAdapter(dir);
    assert.strictEqual(a.readJson("none.json"), null);
    a.writeJson("meta.json", { hello: "world", n: 3 });
    a.writeBin("vec.bin", new Uint8Array([9, 8, 7]).buffer);
    assert.deepStrictEqual(a.readJson("meta.json"), { hello: "world", n: 3 });
    assert.deepStrictEqual(new Uint8Array(a.readBin("vec.bin")), new Uint8Array([9, 8, 7]));

    // Persistencia real: un adapter nuevo sobre el mismo dir lee lo escrito.
    const b = new FileStorageAdapter(dir);
    assert.deepStrictEqual(b.readJson("meta.json"), { hello: "world", n: 3 });

    a.delete("meta.json");
    assert.strictEqual(a.readJson("meta.json"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
