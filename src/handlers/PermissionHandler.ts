import { log } from '../utils/Logger';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  permissionAutoAction,
  pickAllowOptionId,
  pickDenyOptionId,
  type InteractionModeId,
} from '../core/InteractionMode';

export type PermissionUiPrompt = (
  request: PermissionUiRequest,
) => Promise<RequestPermissionResponse>;

export type InteractionModeProvider = () => InteractionModeId;

export type AutoPermissionNotice = {
  action: 'allow' | 'deny';
  accessKind: string;
  title: string;
  paths: string[];
};

export type AutoPermissionListener = (notice: AutoPermissionNotice) => void;

interface AgentPermissionOption {
  optionId: string;
  kind: string;
  name?: string;
}

export interface PermissionUiRequest {
  requestId: string;
  title: string;
  accessKind: string;
  accessSummary: string;
  details: string[];
  command?: string;
  paths: string[];
  options: Array<{
    optionId: string;
    kind: string;
    label: string;
    description: string;
    style: 'allow' | 'reject' | 'danger';
  }>;
  rawToolCall?: unknown;
}

let nextRequestId = 1;

/**
 * Builds Cursor-like labels for Hermes ACP permission options.
 * Only options provided by Hermes are shown — we do not invent new ones.
 */
export function enrichPermissionOptions(
  options: AgentPermissionOption[],
): PermissionUiRequest['options'] {
  return options.map((option) => {
    const id = option.optionId;
    switch (id) {
      case 'allow_once':
        return {
          optionId: id,
          kind: option.kind,
          label: 'Allow once',
          description: 'Run this action one time only. Ask again next time.',
          style: 'allow' as const,
        };
      case 'allow_session':
        return {
          optionId: id,
          kind: option.kind,
          label: 'Allow for session',
          description: 'Allow matching actions until this chat session ends. Not saved permanently.',
          style: 'allow' as const,
        };
      case 'allow_always':
        return {
          optionId: id,
          kind: option.kind,
          label: 'Allow always',
          description: 'Save to Hermes permanent allowlist. Applies to future sessions too.',
          style: 'danger' as const,
        };
      case 'deny':
        return {
          optionId: id,
          kind: option.kind,
          label: 'Reject',
          description: 'Block this action. Hermes must choose another approach.',
          style: 'reject' as const,
        };
      case 'deny_always':
        return {
          optionId: id,
          kind: option.kind,
          label: 'Reject always',
          description: 'Block this pattern going forward where Hermes supports it.',
          style: 'reject' as const,
        };
      default: {
        const isAllow = option.kind.startsWith('allow');
        return {
          optionId: id,
          kind: option.kind,
          label: option.name || id,
          description: isAllow
            ? `Allow (${option.kind})`
            : `Reject (${option.kind})`,
          style: isAllow ? ('allow' as const) : ('reject' as const),
        };
      }
    }
  });
}

function extractTextContent(toolCall: RequestPermissionRequest['toolCall']): string[] {
  const details: string[] = [];
  const content = (toolCall as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return details;
  }
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === 'content' && b.content && typeof b.content === 'object') {
      const inner = b.content as Record<string, unknown>;
      if (inner.type === 'text' && typeof inner.text === 'string' && inner.text.trim()) {
        details.push(inner.text.trim());
      }
    }
    if (b.type === 'diff') {
      const path = typeof b.path === 'string' ? b.path : 'file';
      details.push(`Proposed edit to ${path}`);
    }
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      details.push(b.text.trim());
    }
  }
  return details;
}

export function buildPermissionUiRequest(params: RequestPermissionRequest): PermissionUiRequest {
  const toolCall = params.toolCall as
    | {
        title?: string;
        kind?: string;
        rawInput?: Record<string, unknown>;
        locations?: Array<{ path?: string }>;
        content?: unknown;
      }
    | undefined;

  const title = toolCall?.title || 'Permission Request';
  const kind = toolCall?.kind || 'other';
  const rawInput = toolCall?.rawInput || {};
  const command =
    typeof rawInput.command === 'string'
      ? rawInput.command
      : typeof rawInput.cmd === 'string'
        ? rawInput.cmd
        : undefined;
  const paths = (toolCall?.locations || [])
    .map((l) => l.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  if (typeof rawInput.path === 'string' && !paths.includes(rawInput.path)) {
    paths.push(rawInput.path);
  }

  const kindLabel = (() => {
    switch (kind) {
      case 'execute':
        return 'Run a terminal / shell command';
      case 'edit':
        return 'Modify files on disk';
      case 'write':
        return 'Write files on disk';
      case 'delete':
        return 'Delete files';
      case 'read':
        return 'Read files';
      case 'fetch':
        return 'Access the network';
      default:
        return `Perform a "${kind}" tool action`;
    }
  })();

  const details = extractTextContent(params.toolCall);
  if (command) {
    details.unshift(`$ ${command}`);
  }
  if (typeof rawInput.description === 'string' && rawInput.description.trim()) {
    details.push(rawInput.description.trim());
  }
  for (const [key, value] of Object.entries(rawInput)) {
    if (['command', 'cmd', 'description', 'path'].includes(key)) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      details.push(`${key}: ${String(value)}`);
    }
  }

  let accessSummary = kindLabel;
  if (command) {
    accessSummary = `${kindLabel}: ${command}`;
  } else if (paths.length === 1) {
    accessSummary = `${kindLabel}: ${paths[0]}`;
  } else if (paths.length > 1) {
    accessSummary = `${kindLabel}: ${paths.length} paths`;
  }

  return {
    requestId: `perm-${nextRequestId++}`,
    title,
    accessKind: kind,
    accessSummary,
    details: details.slice(0, 12),
    command,
    paths,
    options: enrichPermissionOptions(params.options || []),
    rawToolCall: toolCall,
  };
}

/**
 * Handles ACP permission requests. Prefer in-chat UI when wired;
 * otherwise fail closed (deny). Interaction mode can auto-allow edits
 * (Agent) or auto-deny edits (Ask / Plan).
 */
export class PermissionHandler {
  private uiPrompt?: PermissionUiPrompt;
  private modeProvider?: InteractionModeProvider;
  private autoListener?: AutoPermissionListener;

  setUiPrompt(prompt: PermissionUiPrompt | undefined): void {
    this.uiPrompt = prompt;
  }

  setInteractionModeProvider(provider: InteractionModeProvider | undefined): void {
    this.modeProvider = provider;
  }

  setAutoPermissionListener(listener: AutoPermissionListener | undefined): void {
    this.autoListener = listener;
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const uiRequest = buildPermissionUiRequest(params);
    const mode = this.modeProvider?.() ?? 'agent';
    const auto = permissionAutoAction(mode, uiRequest.accessKind);
    log(`requestPermission: ${uiRequest.title} (${uiRequest.accessKind}) mode=${mode} auto=${auto}`);

    if (auto === 'allow') {
      const optionId = pickAllowOptionId(params.options || []);
      if (optionId) {
        log(`Auto-allowing ${uiRequest.accessKind} via ${optionId}`);
        this.autoListener?.({
          action: 'allow',
          accessKind: uiRequest.accessKind,
          title: uiRequest.title,
          paths: uiRequest.paths,
        });
        return { outcome: { outcome: 'selected', optionId } };
      }
      log('Auto-allow requested but no allow option — falling through to UI');
    } else if (auto === 'deny') {
      log(`Auto-denying ${uiRequest.accessKind} in ${mode} mode`);
      this.autoListener?.({
        action: 'deny',
        accessKind: uiRequest.accessKind,
        title: uiRequest.title,
        paths: uiRequest.paths,
      });
      return this.deny(params);
    }

    if (!this.uiPrompt) {
      log('No permission UI wired — denying');
      return this.deny(params);
    }

    try {
      const response = await this.uiPrompt(uiRequest);
      const outcome = response?.outcome;
      if (!outcome) {
        return this.deny(params);
      }
      if (outcome.outcome === 'cancelled') {
        return this.deny(params);
      }
      if (outcome.outcome === 'selected') {
        const optionId = outcome.optionId;
        if (!params.options.some((o) => o.optionId === optionId)) {
          log(`Unknown optionId ${optionId} — denying`);
          return this.deny(params);
        }
        return { outcome: { outcome: 'selected', optionId } };
      }
      return this.deny(params);
    } catch (e) {
      log(`Permission UI failed: ${e}`);
      return this.deny(params);
    }
  }

  private deny(params: RequestPermissionRequest): RequestPermissionResponse {
    const denyOptionId = pickDenyOptionId(params.options || []);
    if (denyOptionId) {
      return { outcome: { outcome: 'selected', optionId: denyOptionId } };
    }
    return { outcome: { outcome: 'cancelled' } };
  }
}
