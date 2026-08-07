// ABOUTME: Tests for HistoryStore against an in-memory fake of vscode.SecretStorage.
// ABOUTME: Focused on the security-critical properties: off by default, retention, full purge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HistoryStore, type HistorySettings, type SecretStore } from "../src/history/store";

class FakeSecrets implements SecretStore {
  readonly map = new Map<string, string>();
  get(key: string) {
    return Promise.resolve(this.map.get(key));
  }
  store(key: string, value: string) {
    this.map.set(key, value);
    return Promise.resolve();
  }
  delete(key: string) {
    this.map.delete(key);
    return Promise.resolve();
  }
}

const URI = "file:///p/.env";

function make(settings: Partial<HistorySettings> = {}) {
  const secrets = new FakeSecrets();
  const current: HistorySettings = { enabled: true, maxVersions: 10, ...settings };
  const store = new HistoryStore(secrets, () => current);
  return { secrets, store, current };
}

/** Anything in the fake store that still contains a given secret. */
function leaks(secrets: FakeSecrets, needle: string): string[] {
  return [...secrets.map.entries()].filter(([, v]) => v.includes(needle)).map(([k]) => k);
}

test("stores nothing while disabled", async () => {
  const { secrets, store } = make({ enabled: false });
  assert.equal(await store.capture(URI, ".env", "API_KEY=hunter2"), "disabled");
  assert.equal(secrets.map.size, 0);
  assert.deepEqual(await store.list(URI), []);
});

test("captures a version and reads it back", async () => {
  const { store } = make();
  assert.equal(await store.capture(URI, ".env", "A=1"), "stored");
  const versions = await store.list(URI);
  assert.equal(versions.length, 1);
  assert.equal(await store.contentAt(URI, versions[0].at), "A=1");
});

test("an unchanged save does not pile up duplicate versions", async () => {
  const { store } = make();
  await store.capture(URI, ".env", "A=1");
  assert.equal(await store.capture(URI, ".env", "A=1"), "unchanged");
  assert.equal((await store.list(URI)).length, 1);
});

test("oversized files are skipped rather than stuffed into the keychain", async () => {
  const { secrets, store } = make();
  const huge = "A=" + "x".repeat(300 * 1024);
  assert.equal(await store.capture(URI, ".env", huge), "too-large");
  assert.equal(secrets.map.size, 0);
});

test("retention is enforced on read, so lowering the limit drops the excess", async () => {
  const { store, current, secrets } = make({ maxVersions: 5 });
  for (let i = 0; i < 5; i++) {
    await store.capture(URI, ".env", `A=${i}`);
  }
  assert.equal((await store.list(URI)).length, 5);

  current.maxVersions = 2;
  assert.equal((await store.list(URI)).length, 2);
  // and the excess is really gone from storage, not just hidden from the list
  assert.deepEqual(leaks(secrets, "A=0"), []);
});

test("concurrent captures of different files both stay reachable by clearAll", async () => {
  const { secrets, store } = make();
  const other = "file:///p/other/.env";
  await Promise.all([
    store.capture(URI, ".env", "A=1"),
    store.capture(other, "other/.env", "B=2"),
  ]);

  assert.equal(await store.clearAll(), 2);
  assert.deepEqual(leaks(secrets, "A=1"), []);
  assert.deepEqual(leaks(secrets, "B=2"), []);
});

test("clearAll can still purge a bucket whose index entry was lost", async () => {
  const { secrets, store } = make();
  await store.capture(URI, ".env", "A=1");
  secrets.map.delete("shush.history.index"); // simulate a corrupted/dropped index

  await store.clearAll([URI]);
  assert.deepEqual(leaks(secrets, "A=1"), []);
});

test("clearFile removes only that file", async () => {
  const { secrets, store } = make();
  const other = "file:///p/other/.env";
  await store.capture(URI, ".env", "A=1");
  await store.capture(other, "other/.env", "B=2");

  await store.clearFile(URI);
  assert.deepEqual(leaks(secrets, "A=1"), []);
  assert.equal(leaks(secrets, "B=2").length, 1);
});

test("a corrupt bucket reads as empty instead of throwing", async () => {
  const { secrets, store } = make();
  secrets.map.set("shush.history.file." + "0".repeat(32), "not json");
  assert.deepEqual(await store.list("file:///nope"), []);
});

test("version metadata never carries content", async () => {
  const { store } = make();
  await store.capture(URI, ".env", "API_KEY=hunter2");
  assert.equal(JSON.stringify(await store.list(URI)).includes("hunter2"), false);
});
