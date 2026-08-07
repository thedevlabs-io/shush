// ABOUTME: The "add a value" flow — prompts for a name, then the value in a password box.
// ABOUTME: Split from the editor so the provider stays about wiring, not data entry.

import * as vscode from "vscode";
import { envKeyName, isUnsafeJsonSegment, isValidEnvKey, sanitizeEnvValue } from "../core/model";
import {
  childAt,
  detectFormat,
  detectIndent,
  fullRange,
  isContainer,
  parseJson,
  parseText,
  pathTokens,
  type JsonContainer,
  type JsonValue,
} from "../core/secretsDocument";

/**
 * Add a new key/value. Both prompts run in VS Code's own input box rather than
 * in the webview so the value can use `password: true` — typing a fresh secret
 * into a visible field would leak exactly what this extension exists to hide.
 */
export async function addValue(document: vscode.TextDocument): Promise<void> {
  const format = detectFormat(document);
  let parentPath = "";
  /** Names already present at the insertion point — adding over one would destroy a secret. */
  let taken: Set<string>;
  let intoArray = false;

  if (format === "json") {
    const target = await pickJsonParent(document);
    if (target === undefined) {
      return;
    }
    parentPath = target.path;
    intoArray = target.isArray;
    taken = new Set(target.keys);
  } else {
    taken = new Set(parseText(document.getText(), detectFormat(document)).rows.map((r) => envKeyName(r.label)));
  }

  // An array has no key to ask for — the new value is appended.
  let key = "";
  if (!intoArray) {
    const input = await vscode.window.showInputBox({
      title: "Shush: add a value",
      prompt: format === "env" ? "Variable name" : `Key to add under ${parentPath || "the root"}`,
      validateInput: (raw) => {
        const k = raw.trim();
        if (!k) {
          return "A name is required.";
        }
        if (format === "env" && !isValidEnvKey(k)) {
          return "Use letters, digits, _ . - and start with a letter or underscore.";
        }
        if (taken.has(k)) {
          return `"${k}" already exists here — edit it instead of overwriting it.`;
        }
        if (format === "json" && isUnsafeJsonSegment(k)) {
          return `"${k}" can't be used as a key.`;
        }
        return null;
      },
    });
    if (!input) {
      return;
    }
    key = input.trim();
  }

  const value = await vscode.window.showInputBox({
    title: "Shush: add a value",
    prompt: intoArray
      ? `New item in ${parentPath} (hidden while you type)`
      : `Value for ${key} (hidden while you type)`,
    password: true,
  });
  if (value === undefined) {
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  if (format === "json") {
    const next = insertJsonKey(document, parentPath, key, value);
    if (next === undefined) {
      void vscode.window.showErrorMessage("Shush: couldn't add that key.");
      return;
    }
    edit.replace(document.uri, fullRange(document), next);
  } else {
    const text = document.getText();
    const needsNewline = text.length > 0 && !text.endsWith("\n");
    const line = `${needsNewline ? "\n" : ""}${key}=${sanitizeEnvValue(value)}\n`;
    edit.insert(document.uri, document.positionAt(text.length), line);
  }
  await vscode.workspace.applyEdit(edit);
}

/** Offer every object/array in the document as an insertion point. */
export async function pickJsonParent(
  document: vscode.TextDocument
): Promise<{ path: string; isArray: boolean; keys: string[] } | undefined> {
  const root = parseJson(document.getText());
  if (root === undefined) {
    void vscode.window.showErrorMessage("Shush: this JSON can't be parsed, so it isn't editable.");
    return undefined;
  }
  type Container = { path: string; isArray: boolean; keys: string[] };
  const containers: Container[] = [];
  const walk = (value: JsonValue, path: string): void => {
    if (!isContainer(value)) {
      return;
    }
    const isArray = Array.isArray(value);
    containers.push({ path, isArray, keys: isArray ? [] : Object.keys(value) });
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else {
      for (const [k, v] of Object.entries(value)) {
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(root, "");
  if (containers.length === 0) {
    void vscode.window.showErrorMessage("Shush: this file has no object to add a key to.");
    return undefined;
  }
  if (containers.length === 1) {
    return containers[0];
  }
  const picked = await vscode.window.showQuickPick(
    containers.map((c) => ({
      label: c.path || "(root)",
      description: c.isArray ? "array — appends an item" : undefined,
      container: c,
    })),
    { title: "Shush: where should the new value go?" }
  );
  return picked?.container;
}

/** Serialize the document with `key` added under `parentPath`, or undefined on failure. */
export function insertJsonKey(
  document: vscode.TextDocument,
  parentPath: string,
  key: string,
  value: string
): string | undefined {
  const text = document.getText();
  const root = parseJson(text);
  if (root === undefined || !isContainer(root)) {
    return undefined;
  }
  let node: JsonContainer = root;
  for (const token of parentPath ? pathTokens(parentPath) : []) {
    if (isUnsafeJsonSegment(token)) {
      return undefined;
    }
    const next = childAt(node, token);
    if (next === undefined || !isContainer(next)) {
      return undefined;
    }
    node = next;
  }
  if (Array.isArray(node)) {
    node.push(value);
  } else {
    node[key] = value;
  }
  return JSON.stringify(root, null, detectIndent(text));
}
