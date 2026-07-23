// ABOUTME: Tiny glob matcher and path helpers shared across the extension, so pattern
// ABOUTME: matching behaves identically for built-in and user-configured file patterns.

import * as vscode from "vscode";

export function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

/**
 * Minimal glob matcher supporting the subset we need: `**`, `*`, and `?`.
 * `*` does not cross path separators; `**` does.
 */
export function matchGlob(pattern: string, value: string): boolean {
  let re = "^";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  re += "$";
  return new RegExp(re).test(value);
}

/** True if the file URI matches any of the patterns (relative path, full path, or name). */
export function matchesAny(uri: vscode.Uri, patterns: string[]): boolean {
  if (uri.scheme !== "file") {
    return false;
  }
  const relative = vscode.workspace.asRelativePath(uri, false);
  const name = basename(uri.path);
  return patterns.some(
    (p) =>
      matchGlob(p, relative) || matchGlob(p, uri.path) || matchGlob(p, name)
  );
}
