// ABOUTME: Tests for the key-level version comparison used by the history tab.
// ABOUTME: Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, diffEntries, summarize, type Entry } from "./diff";

const e = (key: string, value: string): Entry => ({ key, value });

test("classifies added, removed, changed and unchanged keys", () => {
  const rows = diffEntries(
    [e("KEEP", "1"), e("CHANGE", "old"), e("GONE", "x")],
    [e("KEEP", "1"), e("CHANGE", "new"), e("NEW", "y")]
  );
  assert.deepEqual(
    rows.map((r) => [r.key, r.kind]),
    [
      ["KEEP", "unchanged"],
      ["CHANGE", "changed"],
      ["NEW", "added"],
      ["GONE", "removed"],
    ]
  );
});

test("a changed row carries both sides so the panel can show before and after", () => {
  const [row] = diffEntries([e("K", "old")], [e("K", "new")]);
  assert.equal(row.before, "old");
  assert.equal(row.after, "new");
});

test("added and removed rows carry only the side that exists", () => {
  const [added] = diffEntries([], [e("K", "v")]);
  assert.equal(added.before, undefined);
  assert.equal(added.after, "v");

  const [removed] = diffEntries([e("K", "v")], []);
  assert.equal(removed.before, "v");
  assert.equal(removed.after, undefined);
});

test("rows follow the newer version's order, with removals appended", () => {
  const rows = diffEntries([e("A", "1"), e("B", "2")], [e("B", "2"), e("C", "3")]);
  assert.deepEqual(
    rows.map((r) => r.key),
    ["B", "C", "A"]
  );
});

test("a value that changes to empty is still a change, not a removal", () => {
  const [row] = diffEntries([e("K", "secret")], [e("K", "")]);
  assert.equal(row.kind, "changed");
});

test("identical versions produce only unchanged rows", () => {
  const rows = diffEntries([e("A", "1")], [e("A", "1")]);
  assert.deepEqual(summarize(rows), { added: 0, removed: 0, changed: 0, unchanged: 1 });
  assert.equal(describe(summarize(rows)), "No differences");
});

test("summary line names every kind of change", () => {
  const rows = diffEntries([e("A", "1"), e("B", "2")], [e("A", "9"), e("C", "3")]);
  assert.equal(describe(summarize(rows)), "1 added, 1 removed, 1 changed");
});
