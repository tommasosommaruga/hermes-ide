import * as vscode from 'vscode';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { SessionManager } from '../core/SessionManager';
import {
  hermesModeForInteraction,
  isInteractionModeId,
  wrapPromptForMode,
  type InteractionModeId,
} from '../core/InteractionMode';
import { SessionUpdateHandler, SessionUpdateListener } from '../handlers/SessionUpdateHandler';
import type { AutoPermissionNotice, PermissionUiRequest } from '../handlers/PermissionHandler';
import type { RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';
import { log, logError } from '../utils/Logger';
import { sendEvent } from '../utils/TelemetryManager';

// Register a focused language set (offline, no CDN, keeps the bundle small).
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cs', csharp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('go', go);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);

/**
 * WebviewViewProvider for the ACP chat sidebar.
 * Renders chat messages, tool calls, plans, and handles user input.
 */
export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'acp-chat';

  private view?: vscode.WebviewView;
  private updateListener: SessionUpdateListener;
  private _hasChatContent = false;
  private interactionMode: InteractionModeId = 'agent';
  private pendingPermissions = new Map<
    string,
    { resolve: (value: RequestPermissionResponse) => void }
  >();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly sessionUpdateHandler: SessionUpdateHandler,
  ) {
    this.interactionMode = this.readInteractionModeSetting();
    // Markdown + offline syntax highlighting (no CDN).
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
    marked.use({
      renderer: {
        code({ text, lang }: { text: string; lang?: string }) {
          const rawLang = (lang || '').trim().split(/\s+/)[0] || '';
          const normalized = rawLang.toLowerCase();
          let language = normalized && hljs.getLanguage(normalized) ? normalized : '';
          let highlighted: string;
          try {
            if (language) {
              highlighted = hljs.highlight(text, { language }).value;
            } else {
              // Prefer common coding languages when the fence has no tag.
              const auto = hljs.highlightAuto(text, [
                'python', 'javascript', 'typescript', 'json', 'bash', 'markdown', 'yaml', 'sql',
              ]);
              highlighted = auto.value;
              language = auto.language || 'text';
            }
          } catch {
            highlighted = text
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
            language = language || 'text';
          }
          const label = language || 'code';
          return (
            `<div class="code-block" data-lang="${label}">` +
            `<div class="code-block-header"><span class="code-lang">${label}</span></div>` +
            `<pre class="hljs"><code class="language-${label}">${highlighted}</code></pre>` +
            `</div>\n`
          );
        },
      },
    });

    // Register as a session update listener
    this.updateListener = (update: SessionNotification) => {
      this.handleSessionUpdate(update);
    };
    this.sessionUpdateHandler.addListener(this.updateListener);
  }

  /**
   * Render markdown text to HTML using marked + highlight.js.
   */
  private renderMarkdown(text: string): string {
    try {
      const html = marked.parse(text) as string;
      return html
        .replace(/<\/?(script|iframe|object|embed|link|meta|style)[^>]*>/gi, '')
        .replace(/\s(on\w+)\s*=\s*(['"]).*?\2/gi, '')
        .replace(/javascript:/gi, '');
    } catch {
      return this.escapeHtml(text);
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'sendPrompt':
          this._hasChatContent = true;
          await this.handleSendPrompt(message.text);
          break;
        case 'cancelTurn':
          await this.handleCancelTurn();
          break;
        case 'setMode':
          await this.handleSetMode(message.modeId);
          break;
        case 'setInteractionMode':
          await this.handleSetInteractionMode(message.modeId);
          break;
        case 'setModel':
          await this.handleSetModel(message.modelId);
          break;
        case 'setConfigOption':
          await this.handleSetConfigOption(message.configId, message.value);
          break;
        case 'executeCommand':
          if (message.command) {
            await vscode.commands.executeCommand(message.command);
          }
          break;
        case 'ready':
          // Webview loaded — send current session state
          this.sendCurrentState();
          break;
        case 'renderMarkdown': {
          // Webview requests markdown rendering for history items
          const items: Array<{index: number; text: string}> = message.items || [];
          const rendered = items.map((item: {index: number; text: string}) => ({
            index: item.index,
            html: this.renderMarkdown(item.text),
          }));
          this.postMessage({ type: 'markdownRendered', items: rendered });
          break;
        }
        case 'permissionResponse': {
          const requestId = String(message.requestId || '');
          const pending = this.pendingPermissions.get(requestId);
          if (!pending) {
            break;
          }
          this.pendingPermissions.delete(requestId);
          if (message.cancelled || !message.optionId) {
            pending.resolve({ outcome: { outcome: 'cancelled' } });
          } else {
            pending.resolve({
              outcome: { outcome: 'selected', optionId: String(message.optionId) },
            });
          }
          break;
        }
        case 'openFilePreview': {
          await this.openFilePreview(String(message.path || ''));
          break;
        }
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /**
   * Forward session update to webview.
   */
  private handleSessionUpdate(update: SessionNotification): void {
    const updateData = update.update as any;

    // Persist session state BEFORE the active-session check. During session
    // creation the agent can dispatch notifications (e.g.
    // `available_commands_update`) before connectToAgent finishes setting
    // `activeSessionId`. Without this, those updates would be dropped and
    // the slash-command popup would never have commands to show.
    if (updateData?.sessionUpdate === 'available_commands_update') {
      this.sessionManager.applyAvailableCommands(
        update.sessionId,
        updateData.availableCommands || [],
      );
    }
    if (updateData?.sessionUpdate === 'config_option_update') {
      this.sessionManager.applyConfigOptions(
        update.sessionId,
        updateData.configOptions || [],
      );
    }
    if (updateData?.sessionUpdate === 'session_info_update') {
      this.sessionManager.applySessionInfoUpdate(update.sessionId, {
        title: updateData.title,
        updatedAt: updateData.updatedAt,
      });
    }

    // Only forward to the webview if this is the active session — the
    // webview only ever shows one session at a time.
    const activeId = this.sessionManager.getActiveSessionId();
    if (update.sessionId !== activeId) { return; }

    this.postMessage({
      type: 'sessionUpdate',
      update: update.update,
      sessionId: update.sessionId,
    });
  }

  getInteractionMode(): InteractionModeId {
    return this.interactionMode;
  }

  private readInteractionModeSetting(): InteractionModeId {
    const raw = vscode.workspace
      .getConfiguration('acp')
      .get<string>('defaultInteractionMode', 'agent');
    return isInteractionModeId(raw) ? raw : 'agent';
  }

  /**
   * Apply the current interaction mode to Hermes (edit-approval session mode)
   * and refresh the chat mode control.
   */
  async onActiveSessionChanged(): Promise<void> {
    this.sendCurrentState();
    await this.syncHermesEditMode();
  }

  private async handleSetInteractionMode(modeId: unknown): Promise<void> {
    if (!isInteractionModeId(modeId)) {
      return;
    }
    this.interactionMode = modeId;
    try {
      await vscode.workspace
        .getConfiguration('acp')
        .update('defaultInteractionMode', modeId, vscode.ConfigurationTarget.Workspace);
    } catch (e) {
      logError('Failed to persist interaction mode', e);
    }
    this.postMessage({ type: 'interactionModeUpdate', modeId });
    await this.syncHermesEditMode();
  }

  /**
   * Map Agent → accept_edits, Ask/Plan → default (ask before edits on Hermes side).
   */
  private async syncHermesEditMode(): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      return;
    }
    const session = this.sessionManager.getSession(activeId);
    const target = hermesModeForInteraction(this.interactionMode);
    const available = session?.modes?.availableModes?.map((m) => m.id) ?? [];
    if (available.length > 0 && !available.includes(target)) {
      log(`Hermes does not advertise mode "${target}" — skipping setMode`);
      return;
    }
    if (session?.modes?.currentModeId === target) {
      return;
    }
    try {
      await this.sessionManager.setMode(activeId, target);
      log(`Applied Hermes edit mode "${target}" for interaction mode "${this.interactionMode}"`);
    } catch (e: any) {
      logError('Failed to sync Hermes edit mode', e);
    }
  }

  /**
   * Handle a prompt sent from the webview.
   */
  private async handleSendPrompt(text: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) {
      this.postMessage({
        type: 'error',
        message: 'No active session. Create a session first.',
      });
      return;
    }

    sendEvent('chat/messageSent', {
      agentName: this.sessionManager.getActiveAgentName() ?? '',
    }, {
      messageLength: text.length,
    });

    // Record the first prompt for the history store (used as a label
    // fallback when no title is supplied by the agent).
    this.sessionManager.recordFirstPrompt(activeId, text);

    // Tell webview we're processing
    this.postMessage({ type: 'promptStart' });

    // Ask / Plan get a soft host prefix; chat UI still shows the user's text only.
    const promptText = wrapPromptForMode(this.interactionMode, text);

    try {
      const response = await this.sessionManager.sendPrompt(activeId, promptText);
      // Render the accumulated assistant text as markdown
      // The webview will have sent us the raw text via promptEnd handling
      this.postMessage({
        type: 'promptEnd',
        stopReason: response.stopReason,
        usage: (response as any).usage,
      });
      this.sessionManager.touchHistory(activeId);
    } catch (e: any) {
      logError('Prompt failed', e);
      this.postMessage({
        type: 'error',
        message: e.message || 'Prompt failed',
      });
      this.postMessage({ type: 'promptEnd', stopReason: 'error' });
    }
  }

  /**
   * Handle cancel request from webview.
   */
  private async handleCancelTurn(): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (activeId) {
      try {
        await this.sessionManager.cancelTurn(activeId);
      } catch (e) {
        logError('Cancel failed', e);
      }
    }
  }

  /**
   * Handle mode change from webview picker.
   */
  private async handleSetMode(modeId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modeId) { return; }
    try {
      await this.sessionManager.setMode(activeId, modeId);
    } catch (e: any) {
      logError('Failed to set mode', e);
      this.postMessage({ type: 'error', message: `Failed to set mode: ${e.message}` });
    }
  }

  /**
   * Handle model change from webview picker.
   */
  private async handleSetModel(modelId: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !modelId) { return; }
    try {
      await this.sessionManager.setModel(activeId, modelId);
    } catch (e: any) {
      logError('Failed to set model', e);
      this.postMessage({ type: 'error', message: `Failed to set model: ${e.message}` });
    }
  }

  /**
   * Handle generic config-option change from webview picker
   * (ACP "Session Config Options"). The agent returns the full
   * configOptions state which we re-broadcast so any cascading
   * changes are reflected in the UI.
   */
  private async handleSetConfigOption(configId: string, value: string): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId || !configId) { return; }
    try {
      const options = await this.sessionManager.setConfigOption(activeId, configId, value);
      this.postMessage({ type: 'configOptionsUpdate', configOptions: options });
    } catch (e: any) {
      logError('Failed to set config option', e);
      this.postMessage({ type: 'error', message: `Failed to set ${configId}: ${e.message}` });
      // Roll back optimistic update on the webview by replaying current state
      const session = this.sessionManager.getSession(activeId);
      this.postMessage({
        type: 'configOptionsUpdate',
        configOptions: session?.configOptions ?? null,
      });
    }
  }

  /**
   * Send current session state to the webview on load.
   */
  private sendCurrentState(): void {
    const activeId = this.sessionManager.getActiveSessionId();
    const session = activeId ? this.sessionManager.getSession(activeId) : null;
    this.postMessage({
      type: 'state',
      activeSessionId: activeId,
      interactionMode: this.interactionMode,
      session: session ? {
        sessionId: session.sessionId,
        agentName: session.agentDisplayName,
        title: session.title,
        cwd: session.cwd,
        modes: session.modes,
        models: session.models,
        configOptions: session.configOptions,
        availableCommands: session.availableCommands,
      } : null,
    });
  }

  /**
   * Post a message to the webview if it exists.
   */
  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  /**
   * Notify webview of a new active session.
   */
  notifyActiveSessionChanged(): void {
    void this.onActiveSessionChanged();
  }

  /**
   * Notify webview of mode state changes.
   */
  notifyModesUpdate(modes: any): void {
    this.postMessage({ type: 'modesUpdate', modes });
  }

  /**
   * Notify webview of model state changes.
   */
  notifyModelsUpdate(models: any): void {
    this.postMessage({ type: 'modelsUpdate', models });
  }

  /**
   * Notify webview of session config-option state changes.
   */
  notifyConfigOptionsUpdate(configOptions: any): void {
    this.postMessage({ type: 'configOptionsUpdate', configOptions });
  }

  /**
   * Notify webview that a `session/load` replay is starting. The webview
   * wipes any previously-displayed history, disables input, and shows a
   * loading overlay until {@link notifyLoadSessionEnd} fires.
   */
  notifyLoadSessionStart(): void {
    this.postMessage({ type: 'loadSessionStart' });
  }

  /** Notify webview that the active replay finished (success or failure). */
  notifyLoadSessionEnd(ok: boolean): void {
    this.postMessage({ type: 'loadSessionEnd', ok });
  }

  /** Notify webview that session title / metadata changed. */
  notifySessionInfoUpdate(title: string | undefined | null): void {
    this.postMessage({ type: 'sessionInfoUpdate', title: title ?? null });
  }

  /**
   * Clear the chat history and reset to welcome state.
   * Called when starting a new conversation.
   */
  clearChat(): void {
    this._hasChatContent = false;
    this.postMessage({ type: 'clearChat' });
  }

  /**
   * Whether the chat has any messages.
   */
  get hasChatContent(): boolean {
    return this._hasChatContent;
  }

  /**
   * Open a workspace/local file in the editor (preview mode).
   */
  private async openFilePreview(filePath: string): Promise<void> {
    const trimmed = filePath.trim();
    if (!trimmed || trimmed.includes('\0')) {
      vscode.window.showWarningMessage('No file path available to preview.');
      return;
    }
    try {
      const uri = vscode.Uri.file(trimmed);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, {
        preview: true,
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.One,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Could not open file preview: ${msg}`);
    }
  }

  /**
   * Generate the HTML content for the webview.
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = getNonce();
    const themeKind = vscode.window.activeColorTheme.kind;
    const lightTheme =
      themeKind === vscode.ColorThemeKind.Light ||
      themeKind === vscode.ColorThemeKind.HighContrastLight;
    const hljsCss = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.extensionUri,
        'media',
        lightTheme ? 'hljs-github.min.css' : 'hljs-github-dark.min.css',
      ),
    );

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${hljsCss}">
  <title>ACP Chat</title>
  <style>
    :root {
      --container-padding: 12px;
      --message-radius: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* Session connected banner */
    .session-banner {
      display: none;
      padding: 10px var(--container-padding);
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
    }
    .session-banner.visible { display: flex; align-items: center; gap: 8px; }
    .session-banner .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed);
      flex-shrink: 0;
    }
    .session-banner .info { flex: 1; }
    .session-banner .agent { font-weight: 600; }
    .session-banner .cwd {
      font-size: 0.85em;
      opacity: 0.6;
      margin-top: 1px;
    }
    .session-banner .status {
      font-size: 0.85em;
      opacity: 0.7;
      flex-shrink: 0;
    }

    /* Messages area */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: var(--container-padding);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .message {
      padding: 8px 12px;
      border-radius: var(--message-radius);
      max-width: 95%;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .message.user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .message.assistant {
      align-self: flex-start;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }
    /* Markdown body inside assistant messages */
    .message.assistant.md-rendered {
      white-space: normal;
    }
    .message.assistant.md-rendered p {
      margin: 0 0 0.5em;
    }
    .message.assistant.md-rendered p:last-child {
      margin-bottom: 0;
    }
    .message.assistant.md-rendered pre {
      background: transparent;
      border: none;
      border-radius: 0;
      padding: 0;
      overflow-x: auto;
      margin: 0;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.88em;
      line-height: 1.45;
    }
    .message.assistant.md-rendered code {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
    }
    .message.assistant.md-rendered pre code {
      background: none;
      padding: 0;
      border-radius: 0;
      display: block;
    }
    .message.assistant.md-rendered .code-block {
      margin: 0.65em 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--vscode-textCodeBlock-background);
    }
    .message.assistant.md-rendered .code-block-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      opacity: 0.85;
    }
    .message.assistant.md-rendered .code-block .hljs {
      padding: 10px 12px;
      margin: 0;
      max-height: 420px;
      overflow: auto;
      background: transparent;
    }
    .message.assistant.md-rendered ul,
    .message.assistant.md-rendered ol {
      margin: 0.4em 0;
      padding-left: 1.5em;
    }
    .message.assistant.md-rendered li {
      margin: 0.15em 0;
    }
    .message.assistant.md-rendered h1,
    .message.assistant.md-rendered h2,
    .message.assistant.md-rendered h3,
    .message.assistant.md-rendered h4 {
      margin: 0.6em 0 0.3em;
      font-weight: 600;
    }
    .message.assistant.md-rendered h1 { font-size: 1.3em; }
    .message.assistant.md-rendered h2 { font-size: 1.15em; }
    .message.assistant.md-rendered h3 { font-size: 1.05em; }
    .message.assistant.md-rendered blockquote {
      border-left: 3px solid var(--vscode-focusBorder);
      margin: 0.4em 0;
      padding: 0.2em 0 0.2em 0.8em;
      opacity: 0.85;
    }
    .message.assistant.md-rendered a {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }
    .message.assistant.md-rendered a:hover {
      text-decoration: underline;
    }
    .message.assistant.md-rendered table {
      border-collapse: collapse;
      margin: 0.4em 0;
      font-size: 0.9em;
    }
    .message.assistant.md-rendered th,
    .message.assistant.md-rendered td {
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 8px;
    }
    .message.assistant.md-rendered th {
      background: var(--vscode-editorWidget-background);
      font-weight: 600;
    }
    .message.assistant.md-rendered hr {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 0.6em 0;
    }
    /* Thought block — collapsible <details> element */
    .thought-block {
      width: 100%;
      margin-bottom: 4px;
    }
    .thought-block summary {
      font-size: 0.85em;
      opacity: 0.7;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 6px;
      list-style: none;
    }
    .thought-block summary::-webkit-details-marker { display: none; }
    .thought-block summary::before {
      content: '▸';
      font-size: 0.9em;
      transition: transform 0.15s;
    }
    .thought-block[open] summary::before {
      content: '▾';
    }
    .thought-block summary:hover { opacity: 1; }
    .thought-block.streaming summary .thought-indicator {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-progressBar-background);
      animation: thoughtPulse 1.2s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes thoughtPulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
    .thought-block .thought-content {
      margin-top: 4px;
      padding: 8px 12px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      font-size: 0.88em;
      opacity: 0.75;
      font-style: italic;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
    }

    .message.error {
      align-self: center;
      background: var(--vscode-inputValidation-errorBackground);
      color: var(--vscode-inputValidation-errorForeground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }

    /* Turn: completed work scrolls up; live writing stays near the input */
    .turn {
      display: flex;
      flex-direction: column;
      gap: 6px;
      align-self: stretch;
      max-width: 100%;
      width: 100%;
    }
    .turn-timeline {
      display: flex;
      flex-direction: column;
      gap: 2px;
      order: 1;
    }
    .turn-live {
      display: flex;
      flex-direction: column;
      gap: 4px;
      order: 2;
      position: sticky;
      bottom: 0;
      z-index: 3;
      padding: 4px 0 2px;
      background: linear-gradient(
        to bottom,
        color-mix(in srgb, var(--vscode-sideBar-background) 0%, transparent),
        var(--vscode-sideBar-background) 18%
      );
    }
    .turn-live > .message.assistant {
      max-width: 100%;
      align-self: stretch;
    }

    /* Tool calls group inside a turn */
    .turn-tools {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding-left: 8px;
      border-left: 2px solid var(--vscode-panel-border);
      margin: 0;
    }
    .turn-tools-summary {
      font-size: 0.78em;
      opacity: 0.55;
      cursor: pointer;
      padding: 1px 0;
      user-select: none;
    }
    .turn-tools-summary:hover { opacity: 0.9; }
    .turn-tools-list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .turn-tools-list.collapsed { display: none; }

    /* Compact completed steps (Cursor-like) */
    .tool-call-inline.is-compact {
      padding: 2px 6px;
      gap: 0;
      opacity: 0.8;
      background: transparent;
      border-color: transparent;
      cursor: pointer;
    }
    .tool-call-inline.is-compact .tc-diff,
    .tool-call-inline.is-compact .tc-details,
    .tool-call-inline.is-compact .tc-actions,
    .tool-call-inline.is-compact .tc-kind {
      display: none !important;
    }
    .tool-call-inline.is-compact .tc-title {
      font-weight: 500;
      font-size: 0.92em;
    }
    .tool-call-inline.is-compact.is-open {
      opacity: 1;
      background: var(--vscode-editorWidget-background);
      border-color: var(--vscode-panel-border);
    }
    .tool-call-inline.is-compact.is-open .tc-diff,
    .tool-call-inline.is-compact.is-open .tc-details,
    .tool-call-inline.is-compact.is-open .tc-actions,
    .tool-call-inline.is-compact.is-open .tc-kind {
      display: block !important;
    }
    .tool-call-inline.is-compact.is-open .tc-actions {
      display: flex !important;
    }
    .tool-call-inline.is-active {
      border-color: color-mix(in srgb, var(--vscode-progressBar-background) 50%, var(--vscode-panel-border));
    }

    .decision-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 6px;
      font-size: 0.8em;
      opacity: 0.75;
      border-radius: 4px;
      cursor: default;
    }
    .decision-row.allow { color: var(--vscode-testing-iconPassed, inherit); }
    .decision-row.deny { color: var(--vscode-testing-iconFailed, inherit); }
    .decision-row .decision-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Live activity + stats strip */
    .live-strip {
      display: none;
      flex-direction: column;
      gap: 4px;
      margin: 0 0 8px;
      padding: 6px 10px;
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      font-size: 0.8em;
    }
    .live-strip.visible { display: flex; }
    .activity-banner {
      display: flex;
      align-items: center;
      gap: 8px;
      opacity: 0.95;
    }
    .activity-banner.idle { display: none; }
    .activity-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--vscode-progressBar-background);
      animation: thoughtPulse 1.2s ease-in-out infinite;
      flex-shrink: 0;
    }
    .activity-banner.waiting .activity-dot {
      background: var(--vscode-charts-orange, #cc7a00);
    }
    .stats-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 12px;
      opacity: 0.85;
      font-variant-numeric: tabular-nums;
    }
    .stats-bar .stat {
      white-space: nowrap;
    }
    .stats-bar .stat strong {
      font-weight: 600;
      opacity: 1;
    }
    .status-chip {
      align-self: flex-start;
      margin: 4px 0;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 0.8em;
      opacity: 0.9;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .status-chip.allow {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed) 22%, transparent);
      color: var(--vscode-foreground);
    }
    .status-chip.deny {
      background: color-mix(in srgb, var(--vscode-testing-iconFailed) 22%, transparent);
      color: var(--vscode-foreground);
    }
    .tool-call-inline.is-edit {
      border-color: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 45%, var(--vscode-panel-border));
    }
    .tool-call-inline .tc-diff {
      margin: 0;
      padding: 6px 8px;
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.75em;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 220px;
      overflow-y: auto;
      line-height: 1.35;
    }
    .tool-call-inline .tc-diff .diff-add {
      color: var(--vscode-gitDecoration-addedResourceForeground, #3fb950);
    }
    .tool-call-inline .tc-diff .diff-del {
      color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149);
    }
    .tool-call-inline .tc-diff .diff-meta {
      opacity: 0.7;
    }
    .message.assistant.streaming-cursor::after {
      content: '▍';
      display: inline-block;
      margin-left: 1px;
      animation: thoughtPulse 1s ease-in-out infinite;
      color: var(--vscode-progressBar-background);
    }

    /* Compact inline tool call — expandable details */
    .tool-call-inline {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 8px;
      font-size: 0.85em;
      border-radius: 6px;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      opacity: 0.95;
    }
    .tool-call-inline .tc-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tool-call-inline .tc-icon {
      flex-shrink: 0;
      width: 14px;
      text-align: center;
    }
    .tool-call-inline .tc-icon.pending { color: var(--vscode-badge-foreground); }
    .tool-call-inline .tc-icon.running { color: var(--vscode-progressBar-background); }
    .tool-call-inline .tc-icon.completed { color: var(--vscode-testing-iconPassed); }
    .tool-call-inline .tc-icon.failed { color: var(--vscode-testing-iconFailed); }
    .tool-call-inline .tc-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    .tool-call-inline .tc-kind {
      font-size: 0.75em;
      opacity: 0.7;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .tool-call-inline .tc-details {
      margin: 0;
      padding: 6px 8px;
      border-radius: 4px;
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.8em;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 180px;
      overflow-y: auto;
    }
    .tool-call-inline .tc-details:empty { display: none; }
    .tool-call-inline .tc-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 2px;
    }
    .tool-call-inline .tc-action {
      font-size: 0.75em;
      padding: 2px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      cursor: pointer;
      font-family: inherit;
    }
    .tool-call-inline .tc-action:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
    }
    .tool-call-inline.is-read .tc-details {
      display: none;
    }
    .tool-call-inline.is-read.expanded .tc-details {
      display: block;
    }
    .tool-call-inline.is-read .tc-title {
      font-weight: 600;
    }

    /* Permission card — only expanded while waiting; then collapses to a decision row */
    .permission-card {
      align-self: stretch;
      margin: 0;
      padding: 10px;
      border-radius: 8px;
      border: 1px solid var(--vscode-focusBorder, var(--vscode-panel-border));
      background: var(--vscode-editorWidget-background);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .permission-card .perm-eyebrow {
      font-size: 0.72em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      opacity: 0.7;
      font-weight: 600;
    }
    .permission-card .perm-title {
      font-size: 0.95em;
      font-weight: 650;
      line-height: 1.3;
    }
    .permission-card .perm-summary {
      font-size: 0.85em;
      line-height: 1.35;
      opacity: 0.9;
    }
    .permission-card .perm-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .permission-card .perm-chip {
      font-size: 0.72em;
      padding: 1px 7px;
      border-radius: 999px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
    }
    .permission-card .perm-details {
      margin: 0;
      padding: 6px 8px;
      border-radius: 6px;
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.78em;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 140px;
      overflow-y: auto;
    }
    .permission-card .perm-actions {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 6px;
    }
    .permission-card .perm-btn {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 1px;
      flex: 1 1 120px;
      text-align: left;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--vscode-button-border, transparent);
      cursor: pointer;
      font-family: inherit;
    }
    .permission-card .perm-btn .perm-btn-label {
      font-weight: 600;
      font-size: 0.85em;
    }
    .permission-card .perm-btn .perm-btn-desc {
      font-size: 0.72em;
      opacity: 0.75;
      line-height: 1.3;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .permission-card .perm-btn.allow {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .permission-card .perm-btn.allow:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .permission-card .perm-btn.danger {
      background: transparent;
      color: var(--vscode-errorForeground);
      border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
    }
    .permission-card .perm-btn.reject {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .permission-card .perm-btn:disabled {
      opacity: 0.5;
      cursor: default;
    }

    /* Legacy standalone tool-call card (for history restore) */
    .tool-call {
      padding: 8px 12px;
      border-radius: var(--message-radius);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
    }
    .tool-call .title {
      font-weight: 600;
      margin-bottom: 4px;
    }
    .tool-call .status-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 0.8em;
      margin-left: 6px;
    }
    .tool-call .status-badge.pending { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .tool-call .status-badge.running { background: var(--vscode-progressBar-background); color: white; }
    .tool-call .status-badge.completed { background: var(--vscode-testing-iconPassed); color: white; }
    .tool-call .status-badge.failed { background: var(--vscode-testing-iconFailed); color: white; }

    /* Plan */
    .plan {
      padding: 8px 12px;
      border-radius: var(--message-radius);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-panel-border);
    }
    .plan .plan-title { font-weight: 600; margin-bottom: 6px; }
    .plan .plan-entry {
      padding: 2px 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .plan .plan-entry.completed { text-decoration: line-through; opacity: 0.6; }

    /* Empty / welcome state */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 24px 20px;
      gap: 6px;
      position: relative;
      z-index: 1;
    }
    .empty-state .icon { font-size: 2.4em; margin-bottom: 4px; opacity: 0.85; }
    .empty-state .title {
      font-size: 1.1em;
      font-weight: 600;
      margin-bottom: 2px;
    }
    .empty-state .subtitle {
      font-size: 0.85em;
      opacity: 0.6;
      margin-bottom: 12px;
      line-height: 1.4;
    }
    .empty-state .actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      max-width: 220px;
    }
    .empty-state .action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      font-weight: 500;
      pointer-events: auto;
      position: relative;
      z-index: 2;
    }
    .empty-state .action-btn.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .empty-state .action-btn.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .empty-state .action-btn.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .empty-state .action-btn.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .empty-state .hint {
      font-size: 0.8em;
      opacity: 0.5;
      margin-top: 8px;
    }
    .empty-state .hint kbd {
      padding: 1px 5px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.95em;
      background: var(--vscode-editor-background);
    }

    /* Session connected banner */
    .session-banner {
      display: none;
      padding: 10px var(--container-padding);
      background: var(--vscode-editorWidget-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
    }
    .session-banner.visible { display: flex; align-items: center; gap: 8px; }

    /* Input area states */
    .input-area.disabled .input-toolbar,
    .input-area.disabled .input-editor-wrap,
    .input-area.disabled .input-send-row { opacity: 0.4; pointer-events: none; }

    /* Input area container */
    .input-area {
      position: relative;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      background: var(--vscode-sideBar-background);
    }

    /* Resize handle */
    .input-resize-handle {
      height: 4px;
      cursor: ns-resize;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .input-resize-handle::after {
      content: '';
      width: 32px;
      height: 2px;
      border-radius: 1px;
      background: var(--vscode-panel-border);
      transition: background 0.15s;
    }
    .input-resize-handle:hover::after {
      background: var(--vscode-focusBorder);
    }

    /* Toolbar row */
    .input-toolbar {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px var(--container-padding) 0;
      flex-shrink: 0;
      flex-wrap: wrap;
    }

    /* Agent / Ask / Plan segmented control */
    .interaction-modes {
      display: inline-flex;
      align-items: stretch;
      border: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.35));
      border-radius: 4px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .interaction-mode-btn {
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: calc(var(--vscode-font-size) - 1px);
      padding: 2px 10px;
      cursor: pointer;
      opacity: 0.75;
      line-height: 1.4;
    }
    .interaction-mode-btn + .interaction-mode-btn {
      border-left: 1px solid var(--vscode-dropdown-border, rgba(128,128,128,0.35));
    }
    .interaction-mode-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }
    .interaction-mode-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      opacity: 1;
    }

    /* Picker wrapper — positioned relatively to anchor the dropdown */
    .picker-wrap {
      position: relative;
      min-width: 0;
      max-width: 100%;
    }
    .picker-wrap.hidden { display: none; }

    /* Picker buttons */
    .picker-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: calc(var(--vscode-font-size) - 1px);
      cursor: pointer;
      white-space: nowrap;
      max-width: 100%;
      min-width: 0;
      opacity: 0.8;
    }
    .picker-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }
    .picker-btn .picker-icon {
      flex-shrink: 0;
      font-size: 14px;
    }
    .picker-btn .picker-label {
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .picker-btn .picker-chevron {
      flex-shrink: 0;
      font-size: 10px;
      opacity: 0.6;
    }

    /* Picker dropdown — sibling of button, positioned from wrapper */
    .picker-dropdown {
      display: none;
      position: absolute;
      bottom: 100%;
      left: 0;
      min-width: 180px;
      max-width: min(420px, calc(100vw - 16px));
      max-height: 240px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      z-index: 100;
      margin-bottom: 4px;
    }
    .picker-dropdown.open { display: block; }
    .picker-dropdown-item {
      padding: 6px 10px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: calc(var(--vscode-font-size) - 1px);
      color: var(--vscode-dropdown-foreground);
    }
    .picker-dropdown-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .picker-dropdown-item.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .picker-dropdown-item .check {
      width: 14px;
      text-align: center;
      flex-shrink: 0;
    }
    .picker-dropdown-item .item-label {
      flex: 1 1 auto;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Floating tooltip used by all picker dropdowns to show option
       description on hover (positioned outside the dropdown). */
    .picker-tooltip {
      position: fixed;
      display: none;
      max-width: 280px;
      padding: 6px 10px;
      background: var(--vscode-editorHoverWidget-background);
      color: var(--vscode-editorHoverWidget-foreground);
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
      border-radius: 4px;
      font-size: calc(var(--vscode-font-size) - 1px);
      line-height: 1.4;
      white-space: normal;
      word-break: break-word;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      pointer-events: none;
      z-index: 300;
    }
    .picker-tooltip.visible { display: block; }

    /* Header for grouped picker options */
    .picker-dropdown-group-header {
      padding: 6px 10px 2px;
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.6;
      pointer-events: none;
      color: var(--vscode-dropdown-foreground);
    }
    .picker-dropdown-group-header:not(:first-child) {
      border-top: 1px solid var(--vscode-panel-border);
      margin-top: 4px;
    }

    /* Dynamic config-options picker row — sits inline with legacy pickers */
    .picker-row {
      display: contents;
    }

    /* Toolbar spacer */
    .toolbar-spacer { flex: 1; }

    /* Editor wrapper */
    .input-editor-wrap {
      padding: 0 var(--container-padding);
      flex: 1;
      min-height: 0;
      display: flex;
    }
    .input-editor-wrap textarea {
      flex: 1;
      resize: none;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 8px 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
      min-height: 38px;
      outline: none;
    }
    .input-editor-wrap textarea:focus {
      border-color: var(--vscode-focusBorder);
    }

    /* Send row */
    .input-send-row {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding: 4px var(--container-padding) 8px;
      gap: 6px;
      flex-shrink: 0;
    }

    /* Send / Stop toggle button — pill-shaped */
    .send-stop-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 4px 14px;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      font-weight: 500;
      white-space: nowrap;
      min-width: 60px;
      height: 26px;
      transition: background 0.15s;
    }
    .send-stop-btn.send {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .send-stop-btn.send:hover {
      background: var(--vscode-button-hoverBackground);
    }
    .send-stop-btn.send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .send-stop-btn.stop {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      color: var(--vscode-inputValidation-errorForeground, #f48771);
      border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    }
    .send-stop-btn.stop:hover {
      opacity: 0.9;
    }

    /* Slash command autocomplete popup */
    .slash-popup {
      display: none;
      position: absolute;
      bottom: 100%;
      left: var(--container-padding);
      right: var(--container-padding);
      max-height: 200px;
      overflow-y: auto;
      background: var(--vscode-editorSuggestWidget-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-dropdown-border));
      border-radius: 6px;
      box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.25);
      z-index: 200;
      margin-bottom: 4px;
    }
    .slash-popup.open { display: block; }
    .slash-popup-header {
      padding: 6px 10px 4px;
      font-size: 0.8em;
      opacity: 0.5;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .slash-popup-item {
      padding: 6px 10px;
      cursor: pointer;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .slash-popup-item:hover,
    .slash-popup-item.active {
      background: var(--vscode-list-hoverBackground);
    }
    .slash-popup-item .cmd-name {
      font-weight: 600;
      color: var(--vscode-textLink-foreground);
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family);
    }
    .slash-popup-item .cmd-desc {
      font-size: 0.9em;
      opacity: 0.7;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    /* Spinner */
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--vscode-foreground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      opacity: 0.6;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Full-area overlay shown while a session is being loaded via session/load */
    .load-overlay {
      display: none;
      position: fixed;
      inset: 0;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, transparent);
      backdrop-filter: blur(2px);
      z-index: 400;
      font-size: 0.9em;
      color: var(--vscode-foreground);
      pointer-events: all;
    }
    .load-overlay.visible { display: flex; }
    .load-overlay .spinner {
      width: 22px;
      height: 22px;
      border-width: 3px;
      opacity: 0.9;
    }
    .load-overlay .label { opacity: 0.85; }
  </style>
</head>
<body>
  <div class="session-banner" id="sessionBanner">
    <span class="dot"></span>
    <div class="info">
      <div class="agent" id="bannerAgent"></div>
      <div class="cwd" id="bannerCwd"></div>
    </div>
    <span class="status" id="status"></span>
  </div>

  <div class="live-strip" id="liveStrip" aria-live="polite">
    <div class="activity-banner idle" id="activityBanner">
      <span class="activity-dot"></span>
      <span id="activityText">Working…</span>
    </div>
    <div class="stats-bar" id="statsBar">
      <span class="stat" id="statElapsed">—</span>
      <span class="stat" id="statTokPerSec">—</span>
      <span class="stat" id="statTokens">—</span>
      <span class="stat" id="statContext">—</span>
      <span class="stat" id="statTools">—</span>
    </div>
  </div>
  <div class="messages" id="messages">
    <div class="empty-state" id="emptyState">
      <div class="icon">🤖</div>
      <div class="title">ACP Chat</div>
      <div class="subtitle">Connect to an AI coding agent to start chatting.</div>
      <div class="actions">
        <button class="action-btn primary" id="welcomeConnectAgent">
          🔌 Connect to Agent
        </button>
        <button class="action-btn secondary" id="welcomeAddAgent">
          ⚙ Add Agent
        </button>
      </div>
      <div class="hint">or press <kbd>Ctrl+Shift+A</kbd> anytime</div>
    </div>
  </div>

  <div class="input-area" id="inputArea">
    <div class="slash-popup" id="slashPopup">
      <div class="slash-popup-header">Commands</div>
    </div>
    <div class="input-resize-handle" id="resizeHandle"></div>
    <div class="input-toolbar">
      <div class="interaction-modes" id="interactionModes" role="group" aria-label="Chat mode">
        <button type="button" class="interaction-mode-btn active" data-mode="agent"
          title="Edit and run tools. Code changes allowed by default.">Agent</button>
        <button type="button" class="interaction-mode-btn" data-mode="ask"
          title="Answer questions only. File edits are blocked.">Ask</button>
        <button type="button" class="interaction-mode-btn" data-mode="plan"
          title="Propose a plan. Do not modify files until you switch to Agent.">Plan</button>
      </div>
      <!-- Dynamic config-options pickers (ACP "Session Config Options"). -->
      <div class="picker-row" id="configOptionsContainer"></div>
      <!-- Hermes edit-approval modes are driven by Agent/Ask/Plan — keep this hidden. -->
      <div class="picker-wrap hidden" id="modePickerWrap">
        <button class="picker-btn" id="modePickerBtn" title="Select mode">
          <span class="picker-icon">⚡</span>
          <span class="picker-label" id="modePickerLabel">Mode</span>
          <span class="picker-chevron">▾</span>
        </button>
        <div class="picker-dropdown" id="modeDropdown"></div>
      </div>
      <div class="picker-wrap hidden" id="modelPickerWrap">
        <button class="picker-btn" id="modelPickerBtn" title="Select model">
          <span class="picker-icon">🧠</span>
          <span class="picker-label" id="modelPickerLabel">Model</span>
          <span class="picker-chevron">▾</span>
        </button>
        <div class="picker-dropdown" id="modelDropdown"></div>
      </div>
      <span class="toolbar-spacer"></span>
    </div>
    <div class="input-editor-wrap">
      <textarea
        id="promptInput"
        placeholder="Type a message..."
        rows="2"
      ></textarea>
    </div>
    <div class="input-send-row">
      <button class="send-stop-btn send" id="sendStopBtn">Send</button>
    </div>
  </div>

  <!-- Shared hover tooltip for picker dropdown items -->
  <div class="picker-tooltip" id="pickerTooltip" role="tooltip"></div>

  <!-- Overlay shown during session/load history replay -->
  <div class="load-overlay" id="loadOverlay" role="status" aria-live="polite">
    <div class="spinner"></div>
    <div class="label">Loading conversation history…</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById('messages');
    const emptyState = document.getElementById('emptyState');
    const promptInput = document.getElementById('promptInput');
    const sendStopBtn = document.getElementById('sendStopBtn');
    const statusEl = document.getElementById('status');
    const sessionBanner = document.getElementById('sessionBanner');
    const bannerAgent = document.getElementById('bannerAgent');
    const bannerCwd = document.getElementById('bannerCwd');
    const inputArea = document.getElementById('inputArea');
    const resizeHandle = document.getElementById('resizeHandle');
    const slashPopup = document.getElementById('slashPopup');
    const liveStrip = document.getElementById('liveStrip');
    const activityBanner = document.getElementById('activityBanner');
    const activityText = document.getElementById('activityText');
    const statElapsed = document.getElementById('statElapsed');
    const statTokPerSec = document.getElementById('statTokPerSec');
    const statTokens = document.getElementById('statTokens');
    const statContext = document.getElementById('statContext');
    const statTools = document.getElementById('statTools');

    let turnStartMs = 0;
    let streamedOutChars = 0;
    let liveToolCount = 0;
    let lastUsage = null; // { inputTokens, outputTokens, totalTokens, thoughtTokens }
    let contextUsed = 0;
    let contextSize = 0;
    let statsTimer = null;
    let activityFallback = 'Thinking…';

    function formatNum(n) {
      if (n == null || !isFinite(n)) return '—';
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(Math.round(n));
    }

    function approxTokensFromChars(chars) {
      return Math.max(0, Math.round(chars / 4));
    }

    function refreshStatsBar() {
      const elapsedSec = turnStartMs ? Math.max(0, (Date.now() - turnStartMs) / 1000) : 0;
      const liveOut = lastUsage && lastUsage.outputTokens != null
        ? lastUsage.outputTokens
        : approxTokensFromChars(streamedOutChars);
      const tokPerSec = elapsedSec >= 0.4 ? (liveOut / elapsedSec) : 0;

      if (statElapsed) {
        statElapsed.innerHTML = turnStartMs
          ? ('⏱ <strong>' + elapsedSec.toFixed(1) + 's</strong>')
          : '⏱ —';
      }
      if (statTokPerSec) {
        statTokPerSec.innerHTML = tokPerSec > 0
          ? ('⚡ <strong>' + tokPerSec.toFixed(1) + '</strong> tok/s')
          : '⚡ — tok/s';
      }
      if (statTokens) {
        if (lastUsage) {
          const parts = [];
          if (lastUsage.inputTokens != null) parts.push('in ' + formatNum(lastUsage.inputTokens));
          if (lastUsage.outputTokens != null) parts.push('out ' + formatNum(lastUsage.outputTokens));
          if (lastUsage.thoughtTokens) parts.push('think ' + formatNum(lastUsage.thoughtTokens));
          statTokens.innerHTML = parts.length
            ? ('🔤 <strong>' + parts.join(' · ') + '</strong>')
            : ('🔤 ~' + formatNum(liveOut) + ' out');
        } else if (streamedOutChars > 0) {
          statTokens.innerHTML = '🔤 ~<strong>' + formatNum(liveOut) + '</strong> out';
        } else {
          statTokens.textContent = '🔤 —';
        }
      }
      if (statContext) {
        if (contextSize > 0) {
          const pct = Math.min(100, Math.round((contextUsed / contextSize) * 100));
          statContext.innerHTML =
            '📊 <strong>' + formatNum(contextUsed) + '</strong>/' + formatNum(contextSize) +
            ' (' + pct + '%)';
        } else {
          statContext.textContent = '📊 context —';
        }
      }
      if (statTools) {
        statTools.innerHTML = liveToolCount > 0
          ? ('🔧 <strong>' + liveToolCount + '</strong> tools')
          : '🔧 —';
      }

      if (liveStrip) {
        const show = isProcessing || contextSize > 0 || !!lastUsage || liveToolCount > 0;
        liveStrip.classList.toggle('visible', show);
      }
    }

    function startStatsTimer() {
      if (statsTimer) return;
      statsTimer = setInterval(refreshStatsBar, 400);
    }

    function stopStatsTimer() {
      if (statsTimer) {
        clearInterval(statsTimer);
        statsTimer = null;
      }
      refreshStatsBar();
    }

    function setActivity(text, waiting) {
      if (!activityBanner || !activityText) return;
      if (!text) {
        if (isProcessing) {
          text = activityFallback;
          waiting = false;
        } else {
          activityBanner.classList.add('idle');
          activityBanner.classList.remove('waiting');
          activityText.textContent = '';
          refreshStatsBar();
          return;
        }
      }
      activityText.textContent = text;
      activityBanner.classList.remove('idle');
      activityBanner.classList.toggle('waiting', !!waiting);
      if (liveStrip) liveStrip.classList.add('visible');
      refreshStatsBar();
    }

    function noteStreamChars(text) {
      if (typeof text === 'string' && text.length) {
        streamedOutChars += text.length;
        refreshStatsBar();
      }
    }

    // Picker elements
    const interactionModesEl = document.getElementById('interactionModes');
    const modePickerWrap = document.getElementById('modePickerWrap');
    const modePickerBtn = document.getElementById('modePickerBtn');
    const modePickerLabel = document.getElementById('modePickerLabel');
    const modeDropdown = document.getElementById('modeDropdown');
    const modelPickerWrap = document.getElementById('modelPickerWrap');
    const modelPickerBtn = document.getElementById('modelPickerBtn');
    const modelPickerLabel = document.getElementById('modelPickerLabel');
    const modelDropdown = document.getElementById('modelDropdown');
    const configOptionsContainer = document.getElementById('configOptionsContainer');
    let currentInteractionMode = 'agent';

    function setInteractionModeUi(modeId) {
      currentInteractionMode = modeId || 'agent';
      if (!interactionModesEl) return;
      interactionModesEl.querySelectorAll('.interaction-mode-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-mode') === currentInteractionMode);
      });
      updatePlaceholder();
    }

    if (interactionModesEl) {
      interactionModesEl.addEventListener('click', function(e) {
        const btn = e.target.closest('.interaction-mode-btn');
        if (!btn) return;
        const modeId = btn.getAttribute('data-mode');
        if (!modeId || modeId === currentInteractionMode) return;
        setInteractionModeUi(modeId);
        vscode.postMessage({ type: 'setInteractionMode', modeId: modeId });
      });
    }

    let hasActiveSession = false;
    let isProcessing = false;

    // Modes / models state (legacy fallback path)
    let availableModes = [];
    let currentModeId = null;
    let availableModels = [];
    let currentModelId = null;

    // ACP Session Config Options state (preferred path)
    let configOptions = [];        // SessionConfigOption[]
    let useConfigOptions = false;  // true when the agent provided configOptions

    // Thinking state
    let currentThoughtEl = null;
    let currentThoughtTextEl = null;
    let currentThoughtText = '';
    let thoughtStartTime = null;
    let thoughtEndTime = null;

    // Slash commands state
    let availableCommands = [];
    let slashPopupSelectedIdx = -1;
    let slashFilteredCommands = [];
    let savedPlaceholder = 'Ask Hermes to edit code, run tools…';

    function modePlaceholder() {
      const placeholders = {
        agent: availableCommands.length > 0
          ? 'Ask Hermes to edit code, or / for commands…'
          : 'Ask Hermes to edit code, run tools…',
        ask: availableCommands.length > 0
          ? 'Ask a question (read-only), or / for commands…'
          : 'Ask a question (read-only)…',
        plan: availableCommands.length > 0
          ? 'Describe what to plan, or / for commands…'
          : 'Describe what to plan…',
      };
      return placeholders[currentInteractionMode] || placeholders.agent;
    }

    function updatePlaceholder() {
      savedPlaceholder = modePlaceholder();
      if (!promptInput.value.startsWith('/')) {
        promptInput.placeholder = savedPlaceholder;
      }
    }

    // --- State persistence ---
    let chatHistory = [];
    let sessionState = null;

    function saveState() {
      vscode.setState({ chatHistory, sessionState, hasActiveSession });
    }

    function restoreState() {
      const saved = vscode.getState();
      if (!saved) return;

      chatHistory = saved.chatHistory || [];
      sessionState = saved.sessionState || null;
      hasActiveSession = saved.hasActiveSession || false;

      if (hasActiveSession && sessionState) {
        showSessionConnectedFromState(sessionState);
      }

      const assistantItems = [];
      for (let i = 0; i < chatHistory.length; i++) {
        const item = chatHistory[i];
        switch (item.kind) {
          case 'message':
            addMessageDOM(item.role, item.text);
            if (item.role === 'assistant') {
              assistantItems.push({ index: i, text: item.text });
            }
            break;
          case 'thought':
            addThoughtDOM(item.text, item.durationSec || 0);
            break;
          case 'toolCall':
            addToolCallDOM(item.toolCallId, item.title, item.status);
            break;
          case 'plan':
            addPlanDOM(item.plan);
            break;
        }
      }

      // Request markdown rendering for all restored assistant messages
      if (assistantItems.length > 0) {
        vscode.postMessage({ type: 'renderMarkdown', items: assistantItems });
      }
    }

    // Start with input disabled
    if (inputArea) inputArea.classList.add('disabled');
    let currentAssistantEl = null;
    let currentAssistantText = '';
    let currentTurnEl = null;       // .turn container for current response
    let currentTimelineEl = null;   // completed steps scroll up here
    let currentLiveEl = null;       // sticky live writing near the input
    let currentToolsListEl = null;  // .turn-tools-list inside timeline
    let currentToolsCountEl = null; // .turn-tools-summary counter
    let currentToolCount = 0;
    let toolCalls = {};
    let activeToolCallId = null;

    // --- Resize handle ---
    let inputAreaHeight = 140;
    const MIN_INPUT_HEIGHT = 90;
    const MAX_INPUT_HEIGHT = 400;

    function applyInputHeight(h) {
      inputAreaHeight = Math.max(MIN_INPUT_HEIGHT, Math.min(MAX_INPUT_HEIGHT, h));
      inputArea.style.height = inputAreaHeight + 'px';
    }

    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = inputArea.offsetHeight;
      function onMove(ev) {
        const delta = startY - ev.clientY;
        applyInputHeight(startHeight + delta);
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // --- Auto-resize textarea (within the input area constraints) ---
    promptInput.addEventListener('input', () => {
      // Slash command autocomplete
      const text = promptInput.value;
      if (text.startsWith('/') && availableCommands.length > 0) {
        const firstSpace = text.indexOf(' ');
        const query = (firstSpace > 0 ? text.slice(1, firstSpace) : text.slice(1)).toLowerCase();
        if (firstSpace < 0) {
          // Still typing command name — show filtered popup
          slashFilteredCommands = availableCommands.filter(c =>
            c.name.toLowerCase().startsWith(query)
          );
          if (slashFilteredCommands.length > 0) {
            renderSlashPopup(slashFilteredCommands);
            slashPopup.classList.add('open');
            slashPopupSelectedIdx = 0;
            highlightSlashItem(0);
          } else {
            slashPopup.classList.remove('open');
          }
        } else {
          slashPopup.classList.remove('open');
        }
      } else {
        slashPopup.classList.remove('open');
        if (!text.startsWith('/')) {
          promptInput.placeholder = savedPlaceholder;
        }
      }
    });

    // Send on Enter (Shift+Enter for newline)
    promptInput.addEventListener('keydown', (e) => {
      // Slash popup navigation
      if (slashPopup.classList.contains('open')) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashPopupSelectedIdx = Math.min(slashPopupSelectedIdx + 1, slashFilteredCommands.length - 1);
          highlightSlashItem(slashPopupSelectedIdx);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashPopupSelectedIdx = Math.max(slashPopupSelectedIdx - 1, 0);
          highlightSlashItem(slashPopupSelectedIdx);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          selectSlashCommand(slashFilteredCommands[slashPopupSelectedIdx]);
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          selectSlashCommand(slashFilteredCommands[slashPopupSelectedIdx]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          slashPopup.classList.remove('open');
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isProcessing) {
          handleCancel();
        } else {
          handleSend();
        }
      }
    });

    function handleSend() {
      const text = promptInput.value.trim();
      if (!text || isProcessing) return;

      addMessage('user', text);
      promptInput.value = '';
      vscode.postMessage({ type: 'sendPrompt', text });
    }

    function handleCancel() {
      vscode.postMessage({ type: 'cancelTurn' });
    }

    function execCmd(command) {
      vscode.postMessage({ type: 'executeCommand', command });
    }

    // Wire up buttons
    sendStopBtn.addEventListener('click', () => {
      if (isProcessing) {
        handleCancel();
      } else {
        handleSend();
      }
    });

    const welcomeConnectAgent = document.getElementById('welcomeConnectAgent');
    const welcomeAddAgent = document.getElementById('welcomeAddAgent');
    if (welcomeConnectAgent) welcomeConnectAgent.addEventListener('click', () => execCmd('acp.connectAgent'));
    if (welcomeAddAgent) welcomeAddAgent.addEventListener('click', () => execCmd('acp.addAgent'));

    // --- Send/Stop toggle ---
    function setProcessing(processing) {
      isProcessing = processing;
      if (processing) {
        sendStopBtn.className = 'send-stop-btn stop';
        sendStopBtn.textContent = '■ Stop';
        sendStopBtn.disabled = false;
        promptInput.disabled = true;
        statusEl.innerHTML = '<span class="spinner"></span>';
      } else {
        sendStopBtn.className = 'send-stop-btn send';
        sendStopBtn.textContent = 'Send';
        sendStopBtn.disabled = false;
        promptInput.disabled = false;
        statusEl.textContent = '';
      }
    }

    // --- Session/load overlay ---
    const loadOverlay = document.getElementById('loadOverlay');
    // True while a session/load replay is in progress. Used to suppress
    // per-chunk markdown rendering until the replay finishes.
    let isLoadingSession = false;

    function handleLoadSessionStart() {
      isLoadingSession = true;
      // Reset all chat state; behaves like clearChat but keeps the session
      // banner / input area structure intact.
      chatHistory = [];
      saveState();
      currentAssistantEl = null;
      currentAssistantText = '';
      toolCalls = {};
      currentTurnEl = null;
      currentTimelineEl = null;
      currentLiveEl = null;
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      activeToolCallId = null;
      currentThoughtEl = null;
      currentThoughtTextEl = null;
      currentThoughtText = '';
      thoughtStartTime = null;
      thoughtEndTime = null;
      messagesEl.innerHTML = '';
      if (emptyState) {
        messagesEl.appendChild(emptyState);
        emptyState.style.display = 'none';
      }
      if (loadOverlay) loadOverlay.classList.add('visible');
      if (inputArea) inputArea.classList.add('disabled');
      setProcessing(false);
    }

    function handleLoadSessionEnd(ok) {
      isLoadingSession = false;
      // Commit any trailing assistant turn captured during the replay.
      finalizeCurrentAssistantTurn();
      if (loadOverlay) loadOverlay.classList.remove('visible');
      if (inputArea) inputArea.classList.remove('disabled');
      // Batch-render markdown for every assistant message captured during
      // the replay (avoids per-chunk render storms).
      const items = [];
      for (let i = 0; i < chatHistory.length; i++) {
        const item = chatHistory[i];
        if (item.kind === 'message' && item.role === 'assistant') {
          items.push({ index: i, text: item.text });
        }
      }
      if (items.length > 0) {
        vscode.postMessage({ type: 'renderMarkdown', items });
      }
      scrollToBottom();
      if (!ok) {
        addMessage('error', 'Failed to load session history.');
      }
    }

    function handleSessionInfoUpdate(title) {
      if (!sessionState) return;
      if (typeof title === 'string') {
        sessionState.title = title;
      } else if (title === null) {
        delete sessionState.title;
      }
      saveState();
      if (bannerAgent) {
        bannerAgent.textContent = sessionState.title || sessionState.agentName || 'Agent';
      }
    }

    // --- Mode / Model pickers ---

    // --- Slash command helpers ---
    function renderSlashPopup(commands) {
      slashPopup.innerHTML = '<div class="slash-popup-header">Commands</div>';
      commands.forEach((cmd, i) => {
        const item = document.createElement('div');
        item.className = 'slash-popup-item' + (i === 0 ? ' active' : '');
        item.dataset.index = String(i);
        item.innerHTML =
          '<span class="cmd-name">/' + escapeHtml(cmd.name) + '</span>' +
          '<span class="cmd-desc">' + escapeHtml(cmd.description) + '</span>';
        item.addEventListener('click', () => selectSlashCommand(cmd));
        item.addEventListener('mouseenter', () => {
          slashPopupSelectedIdx = i;
          highlightSlashItem(i);
        });
        slashPopup.appendChild(item);
      });
    }

    function highlightSlashItem(idx) {
      const items = slashPopup.querySelectorAll('.slash-popup-item');
      items.forEach((el, i) => el.classList.toggle('active', i === idx));
      if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
    }

    function selectSlashCommand(cmd) {
      slashPopup.classList.remove('open');
      if (!cmd) return;

      if (cmd.input) {
        // Command expects input — insert "/name " and set placeholder to hint
        promptInput.value = '/' + cmd.name + ' ';
        promptInput.placeholder = cmd.input.hint || 'Type input...';
        promptInput.focus();
      } else {
        // No input required — send immediately
        promptInput.value = '/' + cmd.name;
        handleSend();
      }
    }

    // --- Mode / Model pickers (cont.) ---
    function updateModePicker(modes) {
      // Hermes edit-approval modes are driven by Agent/Ask/Plan — keep native picker hidden.
      modePickerWrap.classList.add('hidden');
      if (!modes || !modes.availableModes || modes.availableModes.length === 0) {
        availableModes = [];
        currentModeId = null;
        return;
      }
      availableModes = modes.availableModes;
      currentModeId = modes.currentModeId || null;
      renderModeDropdown();
    }

    function renderModeDropdown() {
      modeDropdown.innerHTML = '';
      for (const mode of availableModes) {
        const item = document.createElement('div');
        item.className = 'picker-dropdown-item' + (mode.id === currentModeId ? ' selected' : '');
        item.dataset.desc = mode.description || '';
        if (mode.description) item.title = mode.description;
        item.innerHTML =
          '<span class="check">' + (mode.id === currentModeId ? '✓' : '') + '</span>' +
          '<span class="item-label">' + escapeHtml(mode.name) + '</span>';
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          closePickers();
          if (mode.id !== currentModeId) {
            currentModeId = mode.id;
            const current = availableModes.find(m => m.id === currentModeId);
            modePickerLabel.textContent = current ? current.name : 'Mode';
            renderModeDropdown();
            vscode.postMessage({ type: 'setMode', modeId: mode.id });
          }
        });
        modeDropdown.appendChild(item);
      }
    }

    function updateModelPicker(models) {
      if (!models || !models.availableModels || models.availableModels.length === 0) {
        modelPickerWrap.classList.add('hidden');
        availableModels = [];
        currentModelId = null;
        return;
      }
      availableModels = models.availableModels;
      currentModelId = models.currentModelId || null;
      modelPickerWrap.classList.remove('hidden');
      const current = availableModels.find(m => m.modelId === currentModelId);
      modelPickerLabel.textContent = current ? current.name : 'Model';
      modelPickerLabel.title = current && current.description ? current.description : '';
      renderModelDropdown();
    }

    function renderModelDropdown() {
      modelDropdown.innerHTML = '';
      for (const model of availableModels) {
        const item = document.createElement('div');
        item.className = 'picker-dropdown-item' + (model.modelId === currentModelId ? ' selected' : '');
        item.dataset.desc = model.description || '';
        if (model.description) item.title = model.description;
        item.innerHTML =
          '<span class="check">' + (model.modelId === currentModelId ? '✓' : '') + '</span>' +
          '<span class="item-label">' + escapeHtml(model.name) + '</span>';
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          closePickers();
          if (model.modelId !== currentModelId) {
            currentModelId = model.modelId;
            const current = availableModels.find(m => m.modelId === currentModelId);
            modelPickerLabel.textContent = current ? current.name : 'Model';
            renderModelDropdown();
            vscode.postMessage({ type: 'setModel', modelId: model.modelId });
          }
        });
        modelDropdown.appendChild(item);
      }
    }

    // --- ACP Session Config Options ---

    function iconForCategory(cat) {
      switch (cat) {
        case 'mode': return '⚡';
        case 'model': return '🧠';
        case 'thought_level': return '💭';
        default: return '⚙';
      }
    }

    function isGroupedOptions(opt) {
      const arr = opt && opt.options;
      if (!Array.isArray(arr) || arr.length === 0) return false;
      const first = arr[0];
      return !!(first && typeof first.group === 'string' && Array.isArray(first.options));
    }

    function findOptionValue(opt, value) {
      if (!opt || !Array.isArray(opt.options)) return null;
      if (isGroupedOptions(opt)) {
        for (const group of opt.options) {
          if (!group || !Array.isArray(group.options)) continue;
          const hit = group.options.find(v => v && v.value === value);
          if (hit) return hit;
        }
        return null;
      }
      return opt.options.find(v => v && v.value === value) || null;
    }

    function pickerLabelFor(opt) {
      const v = findOptionValue(opt, opt.currentValue);
      return v && v.name ? v.name : (opt.name || 'Option');
    }

    function pickerTooltipFor(opt) {
      const v = findOptionValue(opt, opt.currentValue);
      return (v && v.description) || opt.description || opt.name || '';
    }

    function renderConfigPickers(opts) {
      configOptionsContainer.innerHTML = '';
      if (!Array.isArray(opts)) return;

      for (const opt of opts) {
        // Spec: ignore unknown types and empty option lists
        if (!opt || opt.type !== 'select') continue;
        if (!Array.isArray(opt.options) || opt.options.length === 0) continue;

        const wrap = document.createElement('div');
        wrap.className = 'picker-wrap';
        wrap.dataset.configId = opt.id;

        const btn = document.createElement('button');
        btn.className = 'picker-btn';
        btn.title = pickerTooltipFor(opt);
        btn.innerHTML =
          '<span class="picker-icon">' + iconForCategory(opt.category) + '</span>' +
          '<span class="picker-label"></span>' +
          '<span class="picker-chevron">▾</span>';
        btn.querySelector('.picker-label').textContent = pickerLabelFor(opt);
        wrap.appendChild(btn);

        const dropdown = document.createElement('div');
        dropdown.className = 'picker-dropdown';
        renderConfigDropdown(dropdown, opt);
        wrap.appendChild(dropdown);

        configOptionsContainer.appendChild(wrap);
      }
    }

    function renderConfigDropdown(dropdown, opt) {
      dropdown.innerHTML = '';
      if (isGroupedOptions(opt)) {
        for (const group of opt.options) {
          if (!group || !Array.isArray(group.options)) continue;
          const header = document.createElement('div');
          header.className = 'picker-dropdown-group-header';
          header.textContent = group.name || group.group || '';
          dropdown.appendChild(header);
          for (const v of group.options) {
            dropdown.appendChild(buildConfigItem(opt, v));
          }
        }
      } else {
        for (const v of opt.options) {
          dropdown.appendChild(buildConfigItem(opt, v));
        }
      }
    }

    function buildConfigItem(opt, v) {
      const selected = v.value === opt.currentValue;
      const item = document.createElement('div');
      item.className = 'picker-dropdown-item' + (selected ? ' selected' : '');
      item.dataset.value = v.value;
      item.dataset.desc = v.description || '';
      if (v.description) item.title = v.description;
      item.innerHTML =
        '<span class="check">' + (selected ? '✓' : '') + '</span>' +
        '<span class="item-label"></span>';
      item.querySelector('.item-label').textContent = v.name || v.value;
      return item;
    }

    // Event delegation: handle clicks on dynamically-rendered config pickers
    configOptionsContainer.addEventListener('click', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;

      const item = target.closest('.picker-dropdown-item');
      if (item) {
        e.stopPropagation();
        const wrap = item.closest('.picker-wrap');
        const dropdown = item.closest('.picker-dropdown');
        if (!wrap || !dropdown) return;
        const configId = wrap.dataset.configId;
        const value = item.dataset.value;
        if (!configId || value == null) return;

        // Find option in current state
        const opt = configOptions.find(o => o && o.id === configId);
        if (!opt || value === opt.currentValue) {
          dropdown.classList.remove('open');
          return;
        }

        // Optimistic update — agent's response will replace with authoritative state
        opt.currentValue = value;
        const labelEl = wrap.querySelector('.picker-btn .picker-label');
        const btn = wrap.querySelector('.picker-btn');
        if (labelEl) labelEl.textContent = pickerLabelFor(opt);
        if (btn) btn.title = pickerTooltipFor(opt);
        renderConfigDropdown(dropdown, opt);

        dropdown.classList.remove('open');
        vscode.postMessage({ type: 'setConfigOption', configId, value });
        return;
      }

      const btn = target.closest('.picker-btn');
      if (btn) {
        e.stopPropagation();
        const wrap = btn.closest('.picker-wrap');
        if (!wrap) return;
        const dropdown = wrap.querySelector('.picker-dropdown');
        if (!dropdown) return;
        const wasOpen = dropdown.classList.contains('open');
        closePickers();
        if (!wasOpen) dropdown.classList.add('open');
      }
    });

    function setConfigOptionsState(opts) {
      configOptions = Array.isArray(opts) ? opts : [];
      useConfigOptions = configOptions.length > 0;

      if (useConfigOptions) {
        // Hide legacy pickers — spec requires configOptions to be used exclusively
        modePickerWrap.classList.add('hidden');
        modelPickerWrap.classList.add('hidden');
        renderConfigPickers(configOptions);
      } else {
        configOptionsContainer.innerHTML = '';
      }
    }

    // Toggle picker dropdowns
    modePickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = modeDropdown.classList.contains('open');
      closePickers();
      if (!wasOpen) modeDropdown.classList.add('open');
    });

    modelPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = modelDropdown.classList.contains('open');
      closePickers();
      if (!wasOpen) modelDropdown.classList.add('open');
    });

    function closePickers() {
      modeDropdown.classList.remove('open');
      modelDropdown.classList.remove('open');
      // Close any dynamic config-option dropdowns
      const open = configOptionsContainer.querySelectorAll('.picker-dropdown.open');
      open.forEach(el => el.classList.remove('open'));
      hidePickerTooltip();
    }

    // --- Picker hover tooltip (shared by all picker dropdowns) ---
    const pickerTooltip = document.getElementById('pickerTooltip');

    function hidePickerTooltip() {
      if (pickerTooltip) pickerTooltip.classList.remove('visible');
    }

    function showPickerTooltip(itemEl) {
      if (!pickerTooltip || !itemEl) return;
      const desc = itemEl.dataset && itemEl.dataset.desc;
      if (!desc) { hidePickerTooltip(); return; }

      pickerTooltip.textContent = desc;
      // Make it measurable while invisible to the user.
      pickerTooltip.style.left = '-9999px';
      pickerTooltip.style.top = '-9999px';
      pickerTooltip.classList.add('visible');

      const dropdown = itemEl.closest('.picker-dropdown');
      if (!dropdown) { hidePickerTooltip(); return; }
      const dropRect = dropdown.getBoundingClientRect();
      const itemRect = itemEl.getBoundingClientRect();
      const tipRect = pickerTooltip.getBoundingClientRect();
      const gap = 6;

      // Prefer left side; flip to right if not enough room.
      let left = dropRect.left - tipRect.width - gap;
      if (left < 4) left = dropRect.right + gap;
      // Clamp horizontally inside the viewport.
      const maxLeft = window.innerWidth - tipRect.width - 4;
      if (left > maxLeft) left = Math.max(4, maxLeft);

      // Vertically align with the hovered item, clamped inside the viewport.
      let top = itemRect.top;
      const maxTop = window.innerHeight - tipRect.height - 4;
      if (top > maxTop) top = Math.max(4, maxTop);

      pickerTooltip.style.left = left + 'px';
      pickerTooltip.style.top = top + 'px';
    }

    // Delegated hover handling — one listener handles every picker dropdown.
    document.addEventListener('mouseover', (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const item = target.closest('.picker-dropdown-item');
      if (!item) return;
      // Only consider items inside an open dropdown.
      const dropdown = item.closest('.picker-dropdown');
      if (!dropdown || !dropdown.classList.contains('open')) return;
      showPickerTooltip(item);
    });

    document.addEventListener('mouseout', (e) => {
      const target = e.target;
      const related = e.relatedTarget;
      if (!(target instanceof Element)) return;
      const item = target.closest('.picker-dropdown-item');
      if (!item) return;
      // Stay visible if the mouse moved to another item inside the same dropdown.
      if (related instanceof Element) {
        const nextItem = related.closest('.picker-dropdown-item');
        if (nextItem && nextItem !== item) return;
      }
      hidePickerTooltip();
    });

    // Hide the tooltip when the user scrolls a dropdown so it doesn't drift.
    function attachScrollHide(dropdownEl) {
      if (!dropdownEl || dropdownEl._tooltipScrollAttached) return;
      dropdownEl._tooltipScrollAttached = true;
      dropdownEl.addEventListener('scroll', hidePickerTooltip);
    }
    attachScrollHide(modeDropdown);
    attachScrollHide(modelDropdown);
    // Dynamic configOption dropdowns: rely on the same handler via event-delegation
    // (they exist inside #configOptionsContainer); attach once per dropdown when created.
    if (configOptionsContainer) {
      const mo = new MutationObserver(() => {
        configOptionsContainer.querySelectorAll('.picker-dropdown').forEach(attachScrollHide);
      });
      mo.observe(configOptionsContainer, { childList: true, subtree: true });
    }

    // Close pickers when clicking outside
    document.addEventListener('click', () => closePickers());

    // --- Messages ---
    function addMessage(role, text) {
      chatHistory.push({ kind: 'message', role, text });
      saveState();
      return addMessageDOM(role, text);
    }

    function addMessageDOM(role, text) {
      hideEmpty();
      const el = document.createElement('div');
      el.className = 'message ' + role;
      el.textContent = text;
      messagesEl.appendChild(el);
      scrollToBottom();
      return el;
    }

    function hideEmpty() {
      if (emptyState) emptyState.style.display = 'none';
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function getStatusIcon(status) {
      switch (status) {
        case 'running':
        case 'in_progress':
        case 'pending':
          return '⟳';
        case 'completed': return '✓';
        case 'failed': return '✗';
        default: return '…';
      }
    }

    function isActiveToolStatus(status) {
      return status === 'pending' || status === 'in_progress' || status === 'running';
    }

    function ensureTurn() {
      if (!currentTurnEl) {
        currentTurnEl = document.createElement('div');
        currentTurnEl.className = 'turn';
        messagesEl.appendChild(currentTurnEl);
        hideEmpty();
      }
      if (!currentTimelineEl) {
        currentTimelineEl = document.createElement('div');
        currentTimelineEl.className = 'turn-timeline';
        currentTurnEl.appendChild(currentTimelineEl);
      }
      if (!currentLiveEl) {
        currentLiveEl = document.createElement('div');
        currentLiveEl.className = 'turn-live';
        currentTurnEl.appendChild(currentLiveEl);
      }
    }

    // Timeline holds completed work; live holds sticky writing near the input.
    function ensureTurnTools() {
      ensureTurn();
      if (!currentToolsListEl) {
        const toolsWrap = document.createElement('div');
        toolsWrap.className = 'turn-tools';

        currentToolCount = 0;
        const summary = document.createElement('div');
        summary.className = 'turn-tools-summary';
        summary.textContent = '▾ Steps';
        currentToolsCountEl = summary;
        summary.addEventListener('click', () => {
          const list = summary.nextElementSibling;
          if (list) {
            const count = parseInt(summary.dataset.count || '0', 10);
            const collapsed = list.classList.toggle('collapsed');
            summary.textContent = (collapsed ? '▸ ' : '▾ ') + count + ' step' + (count !== 1 ? 's' : '');
          }
        });
        toolsWrap.appendChild(summary);

        const list = document.createElement('div');
        list.className = 'turn-tools-list';
        toolsWrap.appendChild(list);
        currentToolsListEl = list;

        currentTimelineEl.appendChild(toolsWrap);
      }
    }

    function appendTimelineItem(el) {
      ensureTurnTools();
      currentToolsListEl.appendChild(el);
      if (currentToolsListEl) currentToolsListEl.classList.remove('collapsed');
    }

    function updateStepsSummary() {
      if (!currentToolsCountEl) return;
      currentToolsCountEl.dataset.count = String(currentToolCount);
      const collapsed = currentToolsListEl && currentToolsListEl.classList.contains('collapsed');
      currentToolsCountEl.textContent =
        (collapsed ? '▸ ' : '▾ ') + currentToolCount + ' step' + (currentToolCount !== 1 ? 's' : '');
    }

    function setToolCompact(el, compact) {
      if (!el) return;
      if (compact) {
        el.classList.add('is-compact');
        el.classList.remove('is-active', 'is-open');
      } else {
        el.classList.remove('is-compact', 'is-open');
        el.classList.add('is-active');
      }
    }

    function collapseInactiveTools(exceptId) {
      Object.keys(toolCalls).forEach(function(id) {
        if (id === exceptId) return;
        const el = toolCalls[id];
        if (!el) return;
        const icon = el.querySelector('.tc-icon');
        const status = icon ? icon.className.replace('tc-icon', '').trim() : '';
        if (!isActiveToolStatus(status)) {
          setToolCompact(el, true);
        }
      });
    }

    function addDecisionRow(action, label, path) {
      ensureTurn();
      const row = document.createElement('div');
      row.className = 'decision-row ' + (action === 'deny' ? 'deny' : 'allow');
      const icon = action === 'deny' ? '✗' : '✓';
      const pathHint = path ? (' · ' + path) : '';
      row.innerHTML =
        '<span>' + icon + '</span>' +
        '<span class="decision-label">' + escapeHtml(label + pathHint) + '</span>';
      if (currentToolsListEl) {
        currentToolsListEl.appendChild(row);
      } else if (currentTimelineEl) {
        currentTimelineEl.appendChild(row);
      } else {
        ensureTurnTools();
        currentToolsListEl.appendChild(row);
      }
      scrollToBottom();
      return row;
    }

    function extractToolPath(tc) {
      if (!tc) return '';
      const raw = tc.rawInput || {};
      if (typeof raw.path === 'string' && raw.path.trim()) return raw.path.trim();
      if (typeof raw.file === 'string' && raw.file.trim()) return raw.file.trim();
      if (typeof raw.file_path === 'string' && raw.file_path.trim()) return raw.file_path.trim();
      if (Array.isArray(tc.locations)) {
        for (const loc of tc.locations) {
          if (loc && typeof loc.path === 'string' && loc.path.trim()) return loc.path.trim();
        }
      }
      return '';
    }

    function isReadTool(tc, title) {
      const kind = String((tc && tc.kind) || '').toLowerCase();
      if (kind === 'read') return true;
      const t = String(title || (tc && tc.title) || '').toLowerCase();
      if (t.includes('read_file') || t.startsWith('read ') || t === 'read') return true;
      // File read without shell command
      if (extractToolPath(tc) && !(tc && tc.rawInput && (tc.rawInput.command || tc.rawInput.cmd))) {
        if (kind === 'other' || kind === '') {
          // Heuristic: title often contains the path for read tools
          return /read|view|cat|open/.test(t);
        }
      }
      return false;
    }

    function isEditTool(tc, title) {
      const kind = String((tc && tc.kind) || '').toLowerCase();
      if (kind === 'edit' || kind === 'write' || kind === 'delete') return true;
      const t = String(title || (tc && tc.title) || '').toLowerCase();
      if (/write_file|patch|edit|write |creat/.test(t)) return true;
      if (Array.isArray(tc && tc.content)) {
        if (tc.content.some(function(b) { return b && b.type === 'diff'; })) return true;
      }
      return false;
    }

    function formatReadTitle(path, title) {
      if (path) {
        const parts = path.replace(/\\\\/g, '/').split('/');
        const leaf = parts[parts.length - 1] || path;
        return 'Read ' + leaf;
      }
      const t = String(title || 'Read file');
      return t.toLowerCase().startsWith('read') ? t : ('Read ' + t);
    }

    function formatEditTitle(path, title, kind) {
      const parts = path ? path.replace(/\\\\/g, '/').split('/') : [];
      const leaf = parts.length ? (parts[parts.length - 1] || path) : '';
      const k = String(kind || '').toLowerCase();
      if (leaf) {
        if (k === 'write' || /write/.test(String(title || '').toLowerCase())) return 'Write ' + leaf;
        if (k === 'delete') return 'Delete ' + leaf;
        return 'Edit ' + leaf;
      }
      return title || 'Edit file';
    }

    function extractDiffBlocks(tc) {
      const diffs = [];
      if (!tc || !Array.isArray(tc.content)) return diffs;
      for (const block of tc.content) {
        if (block && block.type === 'diff') {
          diffs.push({
            path: block.path || '',
            oldText: block.oldText != null ? String(block.oldText) : (block.old_text != null ? String(block.old_text) : null),
            newText: block.newText != null ? String(block.newText) : (block.new_text != null ? String(block.new_text) : ''),
          });
        }
      }
      return diffs;
    }

    function renderDiffHtml(diff) {
      if (!diff) return '';
      const maxLines = 80;
      const oldLines = diff.oldText != null ? diff.oldText.split('\\n') : null;
      const newLines = String(diff.newText || '').split('\\n');
      const parts = [];
      if (diff.path) {
        parts.push('<span class="diff-meta">--- ' + escapeHtml(diff.path) + '</span>');
      }
      if (oldLines == null) {
        // New file / write — show additions
        const slice = newLines.slice(0, maxLines);
        for (const line of slice) {
          parts.push('<span class="diff-add">+ ' + escapeHtml(line) + '</span>');
        }
        if (newLines.length > maxLines) {
          parts.push('<span class="diff-meta">… +' + (newLines.length - maxLines) + ' more lines</span>');
        }
      } else {
        // Compact line-oriented preview (not a full Myers diff)
        const max = Math.max(oldLines.length, newLines.length);
        let shown = 0;
        for (let i = 0; i < max && shown < maxLines; i++) {
          const o = oldLines[i];
          const n = newLines[i];
          if (o === n) {
            if (o != null) parts.push('<span class="diff-meta">  ' + escapeHtml(o) + '</span>');
          } else {
            if (o != null) parts.push('<span class="diff-del">- ' + escapeHtml(o) + '</span>');
            if (n != null) parts.push('<span class="diff-add">+ ' + escapeHtml(n) + '</span>');
          }
          shown++;
        }
        if (max > maxLines) {
          parts.push('<span class="diff-meta">… +' + (max - maxLines) + ' more lines</span>');
        }
      }
      return parts.join('\\n');
    }

    function formatToolDetails(tc) {
      const lines = [];
      if (!tc) return '';
      const kind = tc.kind || '';
      const raw = tc.rawInput || {};
      if (raw.command) lines.push('$ ' + String(raw.command));
      else if (raw.cmd) lines.push('$ ' + String(raw.cmd));
      if (raw.path) lines.push('path: ' + String(raw.path));
      if (raw.description) lines.push(String(raw.description));
      if (Array.isArray(tc.locations)) {
        for (const loc of tc.locations) {
          if (loc && loc.path) lines.push('file: ' + loc.path);
        }
      }
      if (Array.isArray(tc.content)) {
        for (const block of tc.content) {
          if (!block) continue;
          if (block.type === 'diff') {
            // Diffs render in a dedicated preview; skip dumping here.
            continue;
          } else if (block.type === 'content' && block.content && block.content.type === 'text') {
            const t = String(block.content.text || '').trim();
            if (t) lines.push(t.length > 800 ? t.slice(0, 800) + '…' : t);
          } else if (block.type === 'text' && block.text) {
            const t = String(block.text).trim();
            if (t) lines.push(t.length > 800 ? t.slice(0, 800) + '…' : t);
          }
        }
      }
      if (tc.rawOutput != null) {
        const out = typeof tc.rawOutput === 'string' ? tc.rawOutput : JSON.stringify(tc.rawOutput, null, 2);
        if (out && out !== '{}') {
          lines.push('--- output ---');
          lines.push(out.length > 1200 ? out.slice(0, 1200) + '…' : out);
        }
      }
      if (!lines.length && kind) lines.push('kind: ' + kind);
      return lines.join('\\n');
    }

    function addToolCall(toolCallId, title, status, extra) {
      chatHistory.push({ kind: 'toolCall', toolCallId, title, status, extra: extra || null });
      saveState();
      addToolCallInline(toolCallId, title, status, extra);
    }

    function wireToolActions(el, path, readTool) {
      const toggleBtn = el.querySelector('.tc-toggle');
      const openBtn = el.querySelector('.tc-open');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', function() {
          const expanded = el.classList.toggle('expanded');
          toggleBtn.textContent = expanded
            ? (readTool ? 'Hide content' : 'Hide diff')
            : (readTool ? 'Show content' : 'Show diff');
        });
      }
      if (openBtn && path) {
        openBtn.addEventListener('click', function() {
          vscode.postMessage({ type: 'openFilePreview', path: path });
        });
      }
    }

    function applyDiffPreview(el, extra) {
      const diffs = extractDiffBlocks(extra);
      let diffEl = el.querySelector('.tc-diff');
      if (!diffs.length) {
        if (diffEl) diffEl.remove();
        return;
      }
      if (!diffEl) {
        diffEl = document.createElement('pre');
        diffEl.className = 'tc-diff';
        const detailsEl = el.querySelector('.tc-details');
        if (detailsEl) el.insertBefore(diffEl, detailsEl);
        else el.appendChild(diffEl);
      }
      diffEl.innerHTML = diffs.map(renderDiffHtml).join('\\n\\n');
    }

    function addToolCallInline(toolCallId, title, status, extra) {
      hideEmpty();
      ensureTurnTools();
      collapseInactiveTools(toolCallId);
      currentToolCount++;
      liveToolCount = currentToolCount;
      updateStepsSummary();

      const details = formatToolDetails(extra);
      const kind = (extra && extra.kind) ? String(extra.kind) : '';
      const path = extractToolPath(extra) || (extractDiffBlocks(extra)[0] && extractDiffBlocks(extra)[0].path) || '';
      const readTool = isReadTool(extra, title);
      const editTool = !readTool && isEditTool(extra, title);
      const displayTitle = readTool
        ? formatReadTitle(path, title)
        : (editTool ? formatEditTitle(path, title, kind) : (title || 'Tool Call'));
      const el = document.createElement('div');
      el.className = 'tool-call-inline'
        + (readTool ? ' is-read' : '')
        + (editTool ? ' is-edit' : '');
      el.id = 'tc-' + toolCallId;
      if (path) el.dataset.path = path;
      el.dataset.title = displayTitle;

      let actionsHtml = '';
      if (readTool || editTool) {
        actionsHtml =
          '<div class="tc-actions">' +
            (path ? '<button class="tc-action tc-open" type="button">Open preview</button>' : '') +
            (readTool
              ? '<button class="tc-action tc-toggle" type="button">Show content</button>'
              : '') +
          '</div>';
      }

      el.innerHTML =
        '<div class="tc-row">' +
          '<span class="tc-icon ' + status + '">' + getStatusIcon(status) + '</span>' +
          '<span class="tc-title">' + escapeHtml(displayTitle) + '</span>' +
          (path ? '<span class="tc-kind">' + escapeHtml(path) + '</span>' : (kind ? '<span class="tc-kind">' + escapeHtml(kind) + '</span>' : '')) +
        '</div>' +
        actionsHtml +
        '<pre class="tc-details">' + escapeHtml(details) + '</pre>';

      applyDiffPreview(el, extra);
      wireToolActions(el, path, readTool);

      // Click compact row to peek at details (keeps transcript concise by default).
      el.addEventListener('click', function(e) {
        if (!el.classList.contains('is-compact')) return;
        if (e.target.closest('.tc-action')) return;
        el.classList.toggle('is-open');
      });

      appendTimelineItem(el);
      toolCalls[toolCallId] = el;

      if (isActiveToolStatus(status)) {
        activeToolCallId = toolCallId;
        setToolCompact(el, false);
        if (readTool) setActivity('Reading ' + (path || 'file') + '…');
        else if (editTool) setActivity((kind === 'write' ? 'Writing ' : 'Editing ') + (path || 'file') + '…');
        else setActivity('Running: ' + (displayTitle || 'tool'));
      } else {
        setToolCompact(el, true);
        activeToolCallId = null;
        setActivity(null);
      }
      refreshStatsBar();
      scrollToBottom();
    }

    // Fallback DOM builder for history restore (standalone card)
    function addToolCallDOM(toolCallId, title, status) {
      hideEmpty();
      const el = document.createElement('div');
      el.className = 'tool-call';
      el.id = 'tc-' + toolCallId;
      el.innerHTML = '<span class="title">' + escapeHtml(title || 'Tool Call') + '</span>'
        + '<span class="status-badge ' + status + '">' + status + '</span>';
      messagesEl.appendChild(el);
      toolCalls[toolCallId] = el;
      scrollToBottom();
    }

    function updateToolCall(toolCallId, status, title, extra) {
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].kind === 'toolCall' && chatHistory[i].toolCallId === toolCallId) {
          chatHistory[i].status = status;
          if (title) chatHistory[i].title = title;
          if (extra) chatHistory[i].extra = Object.assign({}, chatHistory[i].extra || {}, extra);
          break;
        }
      }
      saveState();

      const el = toolCalls[toolCallId] || document.getElementById('tc-' + toolCallId);
      if (!el) {
        addToolCallInline(toolCallId, title || 'Tool Call', status || 'pending', extra);
        return;
      }

      const iconEl = el.querySelector('.tc-icon');
      if (iconEl) {
        iconEl.className = 'tc-icon ' + status;
        iconEl.textContent = getStatusIcon(status);
        const merged = Object.assign({}, extra || {});
        const path = extractToolPath(merged) || el.dataset.path ||
          ((extractDiffBlocks(merged)[0] && extractDiffBlocks(merged)[0].path) || '');
        const readTool = isReadTool(merged, title || el.querySelector('.tc-title')?.textContent);
        const editTool = !readTool && isEditTool(merged, title || el.querySelector('.tc-title')?.textContent);
        if (title || editTool || readTool) {
          const titleEl = el.querySelector('.tc-title');
          if (titleEl) {
            if (readTool) titleEl.textContent = formatReadTitle(path, title || titleEl.textContent);
            else if (editTool) titleEl.textContent = formatEditTitle(path, title || titleEl.textContent, merged.kind);
            else if (title) titleEl.textContent = title;
          }
        }
        if (extra) {
          const detailsEl = el.querySelector('.tc-details');
          const text = formatToolDetails(merged);
          if (detailsEl && text) detailsEl.textContent = text;
          if (path) el.dataset.path = path;
          if (readTool) el.classList.add('is-read');
          if (editTool) el.classList.add('is-edit');
          applyDiffPreview(el, merged);
          if ((readTool || editTool) && !el.querySelector('.tc-actions')) {
            const actions = document.createElement('div');
            actions.className = 'tc-actions';
            if (path) {
              const openBtn = document.createElement('button');
              openBtn.className = 'tc-action tc-open';
              openBtn.type = 'button';
              openBtn.textContent = 'Open preview';
              actions.appendChild(openBtn);
            }
            if (readTool) {
              const toggleBtn = document.createElement('button');
              toggleBtn.className = 'tc-action tc-toggle';
              toggleBtn.type = 'button';
              toggleBtn.textContent = el.classList.contains('expanded') ? 'Hide content' : 'Show content';
              actions.appendChild(toggleBtn);
            }
            const row = el.querySelector('.tc-row');
            if (row && row.nextSibling) el.insertBefore(actions, row.nextSibling);
            else el.appendChild(actions);
            wireToolActions(el, path, readTool);
          } else if (merged.kind && !path) {
            let kindEl = el.querySelector('.tc-kind');
            if (!kindEl) {
              kindEl = document.createElement('span');
              kindEl.className = 'tc-kind';
              el.querySelector('.tc-row')?.appendChild(kindEl);
            }
            kindEl.textContent = merged.kind;
          }
        }
        if (isActiveToolStatus(status)) {
          activeToolCallId = toolCallId;
          collapseInactiveTools(toolCallId);
          setToolCompact(el, false);
          const label = el.querySelector('.tc-title')?.textContent || title || 'tool';
          if (readTool) setActivity('Reading ' + (path || 'file') + '…');
          else if (editTool) setActivity('Editing ' + (path || 'file') + '…');
          else setActivity('Running: ' + label);
        } else {
          setToolCompact(el, true);
          if (activeToolCallId === toolCallId) activeToolCallId = null;
          activityFallback = 'Thinking…';
          setActivity(null);
        }
        scrollToBottom();
        return;
      }
      const badge = el.querySelector('.status-badge');
      if (badge) {
        badge.className = 'status-badge ' + status;
        badge.textContent = status;
      }
      if (title) {
        const titleEl = el.querySelector('.title');
        if (titleEl) titleEl.textContent = title;
      }
    }

    function showPermissionCard(request) {
      hideEmpty();
      ensureTurn();
      setActivity('Waiting for your approval…', true);
      const card = document.createElement('div');
      card.className = 'permission-card';
      card.id = 'perm-' + request.requestId;
      card.dataset.requestId = request.requestId;
      card.dataset.accessKind = request.accessKind || '';
      card.dataset.path = (request.paths && request.paths[0]) || '';
      card.dataset.title = request.title || request.accessSummary || 'permission';

      const chips = [];
      if (request.accessKind) chips.push('<span class="perm-chip">' + escapeHtml(request.accessKind) + '</span>');
      (request.paths || []).slice(0, 2).forEach(function(p) {
        chips.push('<span class="perm-chip">' + escapeHtml(p) + '</span>');
      });

      const detailText = (request.details || []).slice(0, 6).join('\\n');
      const buttons = (request.options || []).map(function(opt) {
        return '<button class="perm-btn ' + escapeHtml(opt.style || 'allow') + '" data-option-id="' + escapeHtml(opt.optionId) + '">' +
          '<span class="perm-btn-label">' + escapeHtml(opt.label) + '</span>' +
          '<span class="perm-btn-desc">' + escapeHtml(opt.description || '') + '</span>' +
        '</button>';
      }).join('');

      card.innerHTML =
        '<div class="perm-eyebrow">Approval needed</div>' +
        '<div class="perm-title">' + escapeHtml(request.title || 'Continue?') + '</div>' +
        '<div class="perm-summary">' + escapeHtml(request.accessSummary || 'Hermes needs permission.') + '</div>' +
        (chips.length ? '<div class="perm-meta">' + chips.join('') + '</div>' : '') +
        (detailText ? '<pre class="perm-details">' + escapeHtml(detailText) + '</pre>' : '') +
        '<div class="perm-actions">' + buttons + '</div>';

      card.querySelectorAll('.perm-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          if (card.classList.contains('resolved')) return;
          const optionId = btn.getAttribute('data-option-id');
          resolvePermissionCard(card, optionId, btn.querySelector('.perm-btn-label')?.textContent || optionId);
        });
      });

      // Keep the decision near the input while waiting; minimize after choose.
      currentLiveEl.appendChild(card);
      scrollToBottom();
    }

    function resolvePermissionCard(card, optionId, label) {
      if (!card || card.classList.contains('resolved')) return;
      card.classList.add('resolved');
      const denied = !optionId || /reject|deny|cancel/i.test(String(label || optionId));
      const kind = card.dataset.accessKind || 'action';
      const path = card.dataset.path || '';
      const short = optionId
        ? ((denied ? 'Rejected' : 'Allowed') + ' ' + kind + (label ? (': ' + label) : ''))
        : 'Denied / expired';
      addDecisionRow(denied ? 'deny' : 'allow', short, path);
      card.remove();
      setActivity(null);
      vscode.postMessage({
        type: 'permissionResponse',
        requestId: card.dataset.requestId,
        optionId: optionId || null,
        cancelled: !optionId,
      });
      scrollToBottom();
    }

    function addPlan(plan) {
      chatHistory.push({ kind: 'plan', plan: plan });
      saveState();
      addPlanDOM(plan);
    }

    function addPlanDOM(plan) {
      hideEmpty();
      const el = document.createElement('div');
      el.className = 'plan';
      let html = '<div class="plan-title">Plan</div>';
      if (plan.entries) {
        for (const entry of plan.entries) {
          const icon = entry.status === 'completed' ? '✅'
            : entry.status === 'in_progress' ? '🔄' : '⬜';
          const cls = entry.status === 'completed' ? ' completed' : '';
          html += '<div class="plan-entry' + cls + '">'
            + icon + ' ' + escapeHtml(entry.title || entry.description || entry.content || '')
            + '</div>';
        }
      }
      el.innerHTML = html;
      messagesEl.appendChild(el);
      scrollToBottom();
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function finalizeThought() {
      if (!currentThoughtEl) return;
      if (thoughtEndTime) return; // already finalized
      thoughtEndTime = Date.now();
      currentThoughtEl.classList.remove('streaming');
      const elapsed = thoughtStartTime ? Math.round((thoughtEndTime - thoughtStartTime) / 1000) : 0;
      const summary = currentThoughtEl.querySelector('summary');
      if (summary) {
        summary.innerHTML = elapsed > 0
          ? 'Thought for ' + elapsed + 's'
          : 'Thought';
      }
      // Collapse thought into the timeline so writing stays near the input.
      currentThoughtEl.open = false;
      if (currentTimelineEl && currentThoughtEl.parentElement === currentLiveEl) {
        currentTimelineEl.appendChild(currentThoughtEl);
      }
    }

    /**
     * Commit the in-progress assistant turn to chatHistory (without firing
     * the live promptEnd markdown-render request — replay does that
     * batched at loadSessionEnd). Resets all per-turn DOM/state pointers so
     * the next turn starts fresh.
     */
    function finalizeCurrentAssistantTurn() {
      if (currentThoughtText) {
        finalizeThought();
        const tEnd = thoughtEndTime || Date.now();
        chatHistory.push({
          kind: 'thought',
          text: currentThoughtText,
          durationSec: thoughtStartTime ? Math.round((tEnd - thoughtStartTime) / 1000) : 0,
        });
      }
      if (currentAssistantText) {
        chatHistory.push({ kind: 'message', role: 'assistant', text: currentAssistantText });
        saveState();
      }
      collapseInactiveTools(null);
      if (currentAssistantEl) currentAssistantEl.classList.remove('streaming-cursor');
      currentAssistantEl = null;
      currentAssistantText = '';
      currentTurnEl = null;
      currentTimelineEl = null;
      currentLiveEl = null;
      currentToolsListEl = null;
      currentToolsCountEl = null;
      currentToolCount = 0;
      activeToolCallId = null;
      currentThoughtEl = null;
      currentThoughtTextEl = null;
      currentThoughtText = '';
      thoughtStartTime = null;
      thoughtEndTime = null;
    }

    function addThoughtDOM(text, durationSec) {
      hideEmpty();
      const el = document.createElement('details');
      el.className = 'thought-block';
      el.innerHTML =
        '<summary>' + (durationSec > 0 ? 'Thought for ' + durationSec + 's' : 'Thought') + '</summary>' +
        '<div class="thought-content">' + escapeHtml(text) + '</div>';
      messagesEl.appendChild(el);
      scrollToBottom();
    }

    function showSessionConnected(session) {
      hasActiveSession = true;
      sessionState = {
        agentName: session.agentName,
        cwd: session.cwd,
        title: session.title || undefined,
      };
      saveState();
      showSessionConnectedFromState(sessionState);

      // Prefer ACP "Session Config Options" when provided. Spec: clients
      // that support configOptions MUST use them exclusively and ignore
      // the legacy modes field.
      const cfg = session.configOptions;
      if (Array.isArray(cfg) && cfg.length > 0) {
        setConfigOptionsState(cfg);
      } else {
        setConfigOptionsState([]);
        if (session.modes) updateModePicker(session.modes);
        if (session.models) updateModelPicker(session.models);
      }
      // Restore available commands
      if (session.availableCommands) {
        availableCommands = session.availableCommands;
      }
      updatePlaceholder();
    }

    function showSessionConnectedFromState(ss) {
      hasActiveSession = true;
      hideEmpty();
      if (bannerAgent) bannerAgent.textContent = ss.title || ss.agentName || 'Agent';
      if (bannerCwd) bannerCwd.textContent = ss.cwd || '';
      if (sessionBanner) sessionBanner.classList.add('visible');
      if (inputArea) inputArea.classList.remove('disabled');
      promptInput.disabled = false;
    }

    function showNoSession() {
      hasActiveSession = false;
      sessionState = null;
      saveState();
      if (sessionBanner) sessionBanner.classList.remove('visible');
      if (emptyState) emptyState.style.display = '';
      if (inputArea) inputArea.classList.add('disabled');
      // Hide pickers when disconnected
      modePickerWrap.classList.add('hidden');
      modelPickerWrap.classList.add('hidden');
      setConfigOptionsState([]);
    }

    // Handle messages from the extension
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'state':
          if (msg.interactionMode) {
            setInteractionModeUi(msg.interactionMode);
          }
          if (msg.session) {
            showSessionConnected(msg.session);
          } else {
            showNoSession();
          }
          break;

        case 'interactionModeUpdate':
          setInteractionModeUi(msg.modeId || 'agent');
          break;

        case 'autoPermission': {
          const notice = msg.notice || {};
          hideEmpty();
          const path = (notice.paths && notice.paths[0]) || '';
          const label = (notice.action === 'deny' ? 'Blocked' : 'Auto-allowed')
            + ' ' + (notice.accessKind || 'action')
            + (notice.title ? (': ' + notice.title) : '');
          addDecisionRow(notice.action === 'deny' ? 'deny' : 'allow', label, path);
          setActivity(
            notice.action === 'deny'
              ? ('Blocked ' + (notice.accessKind || 'action'))
              : ('Auto-allowed ' + (notice.accessKind || 'edit') + '…'),
          );
          break;
        }

        case 'promptStart':
          setProcessing(true);
          turnStartMs = Date.now();
          streamedOutChars = 0;
          liveToolCount = 0;
          lastUsage = null;
          activityFallback = 'Thinking…';
          startStatsTimer();
          setActivity('Hermes is working…');
          currentAssistantEl = null;
          currentAssistantText = '';
          currentTurnEl = null;
          currentTimelineEl = null;
          currentLiveEl = null;
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          activeToolCallId = null;
          toolCalls = {};
          currentThoughtEl = null;
          currentThoughtTextEl = null;
          currentThoughtText = '';
          thoughtStartTime = null;
          thoughtEndTime = null;
          refreshStatsBar();
          break;

        case 'promptEnd':
          // Finalize thought block if present
          if (currentThoughtText) {
            finalizeThought();
            const tEnd = thoughtEndTime || Date.now();
            chatHistory.push({
              kind: 'thought',
              text: currentThoughtText,
              durationSec: thoughtStartTime ? Math.round((tEnd - thoughtStartTime) / 1000) : 0,
            });
          }
          if (currentAssistantText) {
            chatHistory.push({ kind: 'message', role: 'assistant', text: currentAssistantText });
            saveState();
            // Request markdown rendering from extension host
            if (currentAssistantEl) {
              currentAssistantEl.classList.remove('streaming-cursor');
              vscode.postMessage({
                type: 'renderMarkdown',
                items: [{ index: chatHistory.length - 1, text: currentAssistantText }]
              });
            }
          }
          if (msg.usage) {
            lastUsage = {
              inputTokens: msg.usage.inputTokens ?? msg.usage.input_tokens ?? null,
              outputTokens: msg.usage.outputTokens ?? msg.usage.output_tokens ?? null,
              totalTokens: msg.usage.totalTokens ?? msg.usage.total_tokens ?? null,
              thoughtTokens: msg.usage.thoughtTokens ?? msg.usage.thought_tokens ?? null,
            };
          }
          setProcessing(false);
          stopStatsTimer();
          setActivity(null);
          collapseInactiveTools(null);
          if (currentAssistantEl) currentAssistantEl.classList.remove('streaming-cursor');
          currentAssistantEl = null;
          currentAssistantText = '';
          updateStepsSummary();
          currentTurnEl = null;
          currentTimelineEl = null;
          currentLiveEl = null;
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          activeToolCallId = null;
          currentThoughtEl = null;
          currentThoughtTextEl = null;
          currentThoughtText = '';
          thoughtStartTime = null;
          thoughtEndTime = null;
          break;

        case 'permissionRequest':
          if (msg.request) {
            showPermissionCard(msg.request);
          }
          break;

        case 'permissionExpired': {
          const expired = document.getElementById('perm-' + msg.requestId);
          if (expired && !expired.classList.contains('resolved')) {
            resolvePermissionCard(expired, null, null);
          }
          break;
        }

        case 'clearChat':
          chatHistory = [];
          sessionState = null;
          saveState();
          currentAssistantEl = null;
          currentAssistantText = '';
          toolCalls = {};
          currentTurnEl = null;
          currentTimelineEl = null;
          currentLiveEl = null;
          currentToolsListEl = null;
          currentToolsCountEl = null;
          currentToolCount = 0;
          activeToolCallId = null;
          currentThoughtEl = null;
          currentThoughtTextEl = null;
          currentThoughtText = '';
          thoughtStartTime = null;
          thoughtEndTime = null;
          availableCommands = [];
          slashPopup.classList.remove('open');
          messagesEl.innerHTML = '';
          messagesEl.appendChild(emptyState);
          if (emptyState) emptyState.style.display = '';
          if (sessionBanner) sessionBanner.classList.remove('visible');
          if (inputArea) inputArea.classList.add('disabled');
          modePickerWrap.classList.add('hidden');
          modelPickerWrap.classList.add('hidden');
          setConfigOptionsState([]);
          setProcessing(false);
          break;

        case 'error':
          addMessage('error', msg.message || 'An error occurred');
          break;

        case 'sessionUpdate':
          handleUpdate(msg.update);
          break;

        case 'modesUpdate':
          updateModePicker(msg.modes);
          break;

        case 'modelsUpdate':
          updateModelPicker(msg.models);
          break;

        case 'configOptionsUpdate':
          setConfigOptionsState(msg.configOptions || []);
          break;

        case 'loadSessionStart':
          handleLoadSessionStart();
          break;

        case 'loadSessionEnd':
          handleLoadSessionEnd(!!msg.ok);
          break;

        case 'sessionInfoUpdate':
          handleSessionInfoUpdate(msg.title);
          break;

        case 'markdownRendered': {
          // Extension sent back rendered HTML for messages
          const rendered = msg.items || [];
          for (const item of rendered) {
            // Find the DOM element for this history item
            // For the just-completed streaming message, update the last assistant el
            const historyItem = chatHistory[item.index];
            if (!historyItem || historyItem.role !== 'assistant') continue;

            // Find the element — walk all .message.assistant elements
            const allAssistant = messagesEl.querySelectorAll('.message.assistant');
            // The item.index tracks position in chatHistory; count only assistant messages up to this index
            let assistantIdx = 0;
            for (let i = 0; i < chatHistory.length; i++) {
              if (i === item.index) break;
              if (chatHistory[i].kind === 'message' && chatHistory[i].role === 'assistant') assistantIdx++;
            }
            const el = allAssistant[assistantIdx];
            if (el) {
              el.classList.add('md-rendered');
              el.innerHTML = item.html;
            }
          }
          scrollToBottom();
          break;
        }
      }
    });

    function handleUpdate(update) {
      if (!update) return;
      const type = update.sessionUpdate;

      switch (type) {
        case 'agent_message_chunk': {
          const content = update.content;
          if (content && content.type === 'text' && content.text) {
            currentAssistantText += content.text;
            noteStreamChars(content.text);
            // Don't create visible element until there's non-whitespace content
            if (!currentAssistantEl && !currentAssistantText.trim()) {
              break;
            }
            // Auto-collapse thought when assistant text starts
            if (currentThoughtEl && currentThoughtEl.open) {
              finalizeThought();
              currentThoughtEl.open = false;
            }
            if (!currentAssistantEl) {
              ensureTurn();
              currentAssistantEl = document.createElement('div');
              currentAssistantEl.className = 'message assistant streaming-cursor';
              // Live writing stays in the sticky dock near the input.
              currentLiveEl.appendChild(currentAssistantEl);
            }
            currentAssistantEl.textContent = currentAssistantText;
            activityFallback = 'Writing response…';
            setActivity('Writing response…');
            scrollToBottom();
          }
          break;
        }

        case 'user_message_chunk': {
          // Only the session/load replay path emits this; live prompts
          // never echo the user's message. Use it to break apart historical
          // turns: finalize any pending assistant turn first, then append
          // the historical user message.
          const content = update.content;
          if (content && content.type === 'text' && typeof content.text === 'string') {
            finalizeCurrentAssistantTurn();
            // Coalesce consecutive user chunks into one message.
            const last = chatHistory[chatHistory.length - 1];
            if (last && last.kind === 'message' && last.role === 'user') {
              last.text += content.text;
              const allUser = messagesEl.querySelectorAll('.message.user');
              const el = allUser[allUser.length - 1];
              if (el) el.textContent = last.text;
            } else {
              addMessage('user', content.text);
            }
          }
          break;
        }

        case 'agent_thought_chunk': {
          const content = update.content;
          if (content && content.type === 'text') {
            if (!currentThoughtEl) {
              ensureTurn();
              currentThoughtEl = document.createElement('details');
              currentThoughtEl.className = 'thought-block streaming';
              currentThoughtEl.open = true;
              currentThoughtEl.innerHTML =
                '<summary><span class="thought-indicator"></span> Thinking\u2026</summary>' +
                '<div class="thought-content"></div>';
              currentThoughtTextEl = currentThoughtEl.querySelector('.thought-content');
              // Thought starts in live dock; collapses into timeline when done.
              currentLiveEl.insertBefore(currentThoughtEl, currentLiveEl.firstChild);
              thoughtStartTime = Date.now();
              currentThoughtText = '';
            }
            currentThoughtText += content.text;
            noteStreamChars(content.text);
            currentThoughtTextEl.textContent = currentThoughtText;
            activityFallback = 'Thinking…';
            setActivity('Thinking…');
            scrollToBottom();
          }
          break;
        }

        case 'tool_call': {
          const tc = update;
          addToolCall(
            tc.toolCallId || 'unknown',
            tc.title || 'Tool Call',
            tc.status || 'pending',
            tc,
          );
          break;
        }

        case 'tool_call_update': {
          updateToolCall(
            update.toolCallId || 'unknown',
            update.status || 'completed',
            update.title,
            update,
          );
          break;
        }

        case 'plan': {
          addPlan(update);
          break;
        }

        case 'current_mode_update': {
          // Server pushed a mode change
          currentModeId = update.currentModeId || update.modeId || null;
          const current = availableModes.find(m => m.id === currentModeId);
          if (current) {
            modePickerLabel.textContent = current.name;
            renderModeDropdown();
          }
          break;
        }

        case 'config_option_update': {
          // Server pushed a full configOptions replacement
          setConfigOptionsState(update.configOptions || []);
          break;
        }

        case 'available_commands_update':
          availableCommands = update.availableCommands || [];
          updatePlaceholder();
          break;

        case 'usage_update': {
          if (typeof update.used === 'number') contextUsed = update.used;
          if (typeof update.size === 'number') contextSize = update.size;
          refreshStatsBar();
          break;
        }
      }
    }

    // Restore previous state before telling extension we're ready
    restoreState();

    // Tell extension we're ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  /**
   * Attach a file URI — notify the webview to include it in the next prompt.
   */
  attachFile(uri: vscode.Uri): void {
    if (this.view) {
      this.view.webview.postMessage({
        type: 'file-attached',
        path: uri.fsPath,
        name: uri.fsPath.split(/[\\/]/).pop() || uri.fsPath,
      });
      this.view.show?.(true);
    }
  }

  /**
   * Surface silent Agent/Ask/Plan permission decisions in the chat transcript.
   */
  notifyAutoPermission(notice: AutoPermissionNotice): void {
    this._hasChatContent = true;
    this.postMessage({
      type: 'autoPermission',
      notice,
    });
  }

  /**
   * Show a Cursor-like permission card in chat and wait for the user's choice.
   */
  async promptPermission(request: PermissionUiRequest): Promise<RequestPermissionResponse> {
    await this.view?.show?.(true);
    this._hasChatContent = true;

    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(request.requestId, { resolve });
      this.postMessage({
        type: 'permissionRequest',
        request,
      });

      // Fail closed if the user never answers (Hermes also has its own timeout).
      setTimeout(() => {
        if (!this.pendingPermissions.has(request.requestId)) {
          return;
        }
        this.pendingPermissions.delete(request.requestId);
        this.postMessage({
          type: 'permissionExpired',
          requestId: request.requestId,
        });
        resolve({ outcome: { outcome: 'cancelled' } });
      }, 300_000);
    });
  }

  dispose(): void {
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.pendingPermissions.clear();
    this.sessionUpdateHandler.removeListener(this.updateListener);
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
