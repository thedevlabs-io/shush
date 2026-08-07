// ABOUTME: A CustomTextEditor that renders secret files with values masked by default.
// ABOUTME: Handles env (KEY=VALUE) files and JSON files (key-aware leaf redaction).

import * as vscode from "vscode";
import { HistoryStore } from "../history/store";
import {
  isUnsafeJsonSegment,
  sanitizeEnvValue,
  type SnapshotMeta,
} from "../core/model";

import { redactedEditorHtml } from "./redactedEditorHtml";
import { addValue } from "./addValue";
import { openHistoryTab, restoreVersion, type VersionContext } from "./versionTab";
import { SnapshotRecorder } from "../history/capture";
import {
  asMessage,
  coerce,
  childAt,
  detectFormat,
  detectIndent,
  fullRange,
  isContainer,
  parseEnvLine,
  parseJson,
  parseText,
  pathTokens,
  setChild,
  type JsonContainer,
  type Parsed,
} from "../core/secretsDocument";

// ---- provider ------------------------------------------------------------

export class RedactedEnvEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "shush.redactedEditor";

  public static register(
    context: vscode.ExtensionContext,
    history: HistoryStore
  ): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      RedactedEnvEditorProvider.viewType,
      new RedactedEnvEditorProvider(history),
      { webviewOptions: { retainContextWhenHidden: false } }
    );
  }

  private readonly recorder: SnapshotRecorder;
  private readonly versions: VersionContext;

  constructor(private readonly history: HistoryStore) {
    this.recorder = new SnapshotRecorder(history);
    this.versions = { history, recorder: this.recorder };
  }

  private parse(document: vscode.TextDocument): Parsed {
    return parseText(document.getText(), detectFormat(document));
  }

  public resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = redactedEditorHtml();

    const isThisDoc = (uri: vscode.Uri) => uri.toString() === document.uri.toString();

    const post = () => {
      const parsed = this.parse(document);
      void webviewPanel.webview.postMessage({
        type: "load",
        rows: parsed.rows,
        note: parsed.note,
        format: parsed.format,
        historyEnabled: this.history.enabled,
        fileName: document.uri.path.split("/").pop(),
      });
    };

    const postVersions = async () => {
      const versions: SnapshotMeta[] = this.history.enabled
        ? await this.history.list(document.uri.toString())
        : [];
      void webviewPanel.webview.postMessage({ type: "versions", versions });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (isThisDoc(e.document.uri)) {
        post();
      }
    });

    // Only files opened in this editor are snapshotted — i.e. files Shush protects.
    const saveSub = vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!isThisDoc(doc.uri)) {
        return;
      }
      await this.recorder.capture(doc);
      await postVersions();
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("shush.history")) {
        post();
        void postVersions();
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      saveSub.dispose();
      configSub.dispose();
    });

    webviewPanel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const msg = asMessage(raw);
      if (!msg) {
        return;
      }
      if (msg.type === "ready") {
        post();
        await postVersions();
      } else if (msg.type === "edit") {
        await this.applyEdit(document, String(msg.id), String(msg.value));
      } else if (msg.type === "openText") {
        await vscode.commands.executeCommand("shush.openAsText", document.uri);
      } else if (msg.type === "add") {
        await addValue(document);
      } else if (msg.type === "toggleHistory") {
        await vscode.commands.executeCommand("shush.toggleHistory");
      } else if (msg.type === "versions") {
        await postVersions();
      } else if (msg.type === "diffVersion") {
        await openHistoryTab(this.versions, document, String(msg.at), "current");
      } else if (msg.type === "restoreVersion") {
        await restoreVersion(this.versions, document, Number(msg.at));
        await postVersions();
      } else if (msg.type === "clearHistory") {
        await this.history.clearFile(document.uri.toString());
        await postVersions();
      }
    });
  }

  private async applyEdit(
    document: vscode.TextDocument,
    id: string,
    value: string
  ): Promise<void> {
    if (id === "__raw__") {
      return; // unparseable file — editing disabled
    }
    const format = detectFormat(document);
    const edit = new vscode.WorkspaceEdit();

    if (format === "json") {
      const root = parseJson(document.getText());
      if (root === undefined || !isContainer(root)) {
        return;
      }
      const tokens = pathTokens(id);
      if (tokens.some(isUnsafeJsonSegment)) {
        return; // would be silently dropped by the engine — refuse rather than lose the edit
      }
      let node: JsonContainer = root;
      for (let i = 0; i < tokens.length - 1; i++) {
        const next = childAt(node, tokens[i]);
        if (next === undefined || !isContainer(next)) {
          return;
        }
        node = next;
      }
      const leaf = tokens[tokens.length - 1];
      setChild(node, leaf, coerce(childAt(node, leaf), value));
      const indent = detectIndent(document.getText());
      const serialized = JSON.stringify(root, null, indent);
      if (serialized === document.getText()) {
        return;
      }
      edit.replace(document.uri, fullRange(document), serialized);
    } else {
      const line = Number(id.slice(1));
      if (!(line >= 0 && line < document.lineCount)) {
        return;
      }
      const parsed = parseEnvLine(document.lineAt(line).text, line);
      if (!parsed) {
        return;
      }
      const newText = `${parsed.key}${parsed.sep}${sanitizeEnvValue(value)}`;
      if (newText === document.lineAt(line).text) {
        return;
      }
      edit.replace(document.uri, document.lineAt(line).range, newText);
    }

    await vscode.workspace.applyEdit(edit);
  }

}
