// ABOUTME: Unit tests for the find bar's row filtering — scope, case sensitivity and tree context.
// ABOUTME: Run with `npm test` — bundled by esbuild and executed under node:test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { filterRows, type SearchRow } from "./search";

const env: SearchRow[] = [
  { depth: 0, label: "API_KEY", value: "sk-live-123" },
  { depth: 0, label: "DATABASE_URL", value: "postgres://localhost" },
  { depth: 0, label: "PORT", value: "3000" },
];

test("an empty query keeps every row and reports no matches", () => {
  const r = filterRows(env, "   ", "both", false);
  assert.deepEqual(r.keep, [true, true, true]);
  assert.equal(r.matches, 0);
});

test("keys scope matches the name only", () => {
  const r = filterRows(env, "api", "keys", false);
  assert.deepEqual(r.keep, [true, false, false]);
  assert.equal(r.matches, 1);
});

test("values scope matches the secret without touching key names", () => {
  const r = filterRows(env, "postgres", "values", false);
  assert.deepEqual(r.keep, [false, true, false]);

  // "PORT" is a key, not a value — values scope must not find it.
  assert.deepEqual(filterRows(env, "PORT", "values", false).keep, [false, false, false]);
});

test("both scope unions the two", () => {
  const r = filterRows(env, "sk-live", "both", false);
  assert.deepEqual(r.keep, [true, false, false]);
});

test("case sensitivity is honoured", () => {
  assert.equal(filterRows(env, "api_key", "keys", true).matches, 0);
  assert.equal(filterRows(env, "API_KEY", "keys", true).matches, 1);
});

const json: SearchRow[] = [
  { depth: 0, label: "firebase", container: true },
  { depth: 1, label: "apiKey", value: "AIza-secret" },
  { depth: 1, label: "projectId", value: "demo" },
  { depth: 0, label: "other", container: true },
  { depth: 1, label: "token", value: "nope" },
];

test("a matching leaf keeps its ancestor containers", () => {
  const r = filterRows(json, "AIza", "values", false);
  assert.deepEqual(r.keep, [true, true, false, false, false]);
  assert.equal(r.matches, 1);
});

test("a matching container keeps its whole subtree", () => {
  const r = filterRows(json, "firebase", "keys", false);
  assert.deepEqual(r.keep, [true, true, true, false, false]);
  assert.equal(r.matches, 1, "children kept for context are not counted as matches");
});

test("nothing matches when the query is absent from both sides", () => {
  const r = filterRows(json, "zzz", "both", false);
  assert.deepEqual(r.keep, [false, false, false, false, false]);
  assert.equal(r.matches, 0);
});

test("a nested matching container does not drop the outer container's other children", () => {
  const nested: SearchRow[] = [
    { depth: 0, label: "firebase", container: true },
    { depth: 1, label: "firebaseOpts", container: true },
    { depth: 2, label: "a", value: "1" },
    { depth: 1, label: "projectId", value: "demo" },
    { depth: 1, label: "appId", value: "x" },
  ];
  const r = filterRows(nested, "firebase", "keys", false);
  assert.deepEqual(r.keep, [true, true, true, true, true]);
});

test("a container row is never matched by value scope, and a valueless leaf is skipped", () => {
  const rows: SearchRow[] = [
    { depth: 0, label: "group", container: true },
    { depth: 1, label: "empty" },
  ];
  assert.equal(filterRows(rows, "group", "values", false).matches, 0);
  assert.equal(filterRows(rows, "empty", "values", false).matches, 0);
});

test("surrounding whitespace in a query is ignored, as it is for emptiness", () => {
  assert.deepEqual(filterRows(env, "  PORT  ", "keys", false).keep, [false, false, true]);
});

// The webview embeds this function's source inside a template literal in an inline
// <script>. A backtick or ${ in the source would break out of it and inject code.
test("the filter's source is safe to embed in the webview script", () => {
  const source = filterRows.toString();
  assert.ok(!/[`]|\$\{/.test(source), "source must contain no backtick or ${");
  assert.doesNotThrow(() => new Script("(" + source + ")"), "source must parse standalone");
});
