// ABOUTME: Unit tests for the pure helpers behind add-row validation and history pruning.
// ABOUTME: Run with `npm test` — bundled by esbuild and executed under node:test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileId, isValidEnvKey, prune, sanitizeEnvValue, toMeta } from "./model";

test("accepts conventional env keys", () => {
  for (const k of ["API_KEY", "_private", "app.name", "MY-KEY", "K1"]) {
    assert.equal(isValidEnvKey(k), true, k);
  }
});

test("rejects keys that would not parse back out of the file", () => {
  for (const k of ["1KEY", "has space", "KEY=VALUE", "", "KEY\nOTHER", "a#b"]) {
    assert.equal(isValidEnvKey(k), false, JSON.stringify(k));
  }
});

test("a newline in a value cannot inject an extra variable", () => {
  const injected = sanitizeEnvValue("secret\nADMIN=true");
  assert.equal(injected.includes("\n"), false);
  assert.equal(injected, "secret ADMIN=true");
  assert.equal(sanitizeEnvValue("a\r\nb"), "a b");
});

test("ordinary values pass through untouched", () => {
  assert.equal(sanitizeEnvValue('pk_live_x"y z'), 'pk_live_x"y z');
});

test("file ids are stable, per-uri, and reveal no path", () => {
  const a = fileId("file:///home/me/project/.env");
  assert.equal(a, fileId("file:///home/me/project/.env"));
  assert.notEqual(a, fileId("file:///home/me/other/.env"));
  assert.match(a, /^[0-9a-f]{32}$/);
});

test("prune keeps the newest versions, newest first", () => {
  const snaps = [1, 5, 3, 9].map((at) => ({ at, bytes: 1, content: `v${at}` }));
  const kept = prune(snaps, 2);
  assert.deepEqual(
    kept.map((s) => s.at),
    [9, 5]
  );
});

test("prune always keeps at least one version", () => {
  const snaps = [{ at: 1, bytes: 1, content: "v" }];
  assert.equal(prune(snaps, 0).length, 1);
});

test("metadata sent to the webview carries no secret content", () => {
  const meta = toMeta([{ at: 7, bytes: 12, content: "API_KEY=hunter2" }]);
  assert.deepEqual(meta, [{ at: 7, bytes: 12 }]);
  assert.equal(JSON.stringify(meta).includes("hunter2"), false);
});
