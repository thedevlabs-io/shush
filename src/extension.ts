// ABOUTME: Entry point — registers a custom editor that opens .env files with values
// ABOUTME: masked by default, so secrets never render on screen until explicitly revealed.

import * as vscode from "vscode";
import { RedactedEnvEditorProvider } from "./redactedEditor";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(RedactedEnvEditorProvider.register(context));
}

export function deactivate(): void {
  // Nothing to tear down; the custom editor is disposed via subscriptions.
}
