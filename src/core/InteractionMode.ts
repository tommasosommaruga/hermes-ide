/**
 * Host-side Cursor-like interaction modes for Hermes ACP.
 *
 * Hermes natively exposes edit-approval modes (default / accept_edits / dont_ask).
 * We map a simpler Agent | Ask | Plan control onto that, plus host permission policy.
 */

export type InteractionModeId = 'agent' | 'ask' | 'plan';

export const INTERACTION_MODES: ReadonlyArray<{
  id: InteractionModeId;
  label: string;
  description: string;
}> = [
  {
    id: 'agent',
    label: 'Agent',
    description: 'Edit and run tools. Code changes are allowed by default.',
  },
  {
    id: 'ask',
    label: 'Ask',
    description: 'Answer questions only. File edits are blocked.',
  },
  {
    id: 'plan',
    label: 'Plan',
    description: 'Propose a plan. Do not modify files until you switch to Agent.',
  },
];

/** Hermes ACP session mode ids (edit-approval policy). */
export type HermesEditModeId = 'default' | 'accept_edits' | 'dont_ask';

const EDIT_KINDS = new Set(['edit', 'write']);
const READ_KINDS = new Set(['read']);
const DESTRUCTIVE_KINDS = new Set(['delete']);

export function isInteractionModeId(value: unknown): value is InteractionModeId {
  return value === 'agent' || value === 'ask' || value === 'plan';
}

export function hermesModeForInteraction(mode: InteractionModeId): HermesEditModeId {
  switch (mode) {
    case 'agent':
      return 'accept_edits';
    case 'ask':
    case 'plan':
      return 'default';
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

export function promptPrefixForMode(mode: InteractionModeId): string | null {
  switch (mode) {
    case 'agent':
      return null;
    case 'ask':
      return (
        '[Hermes IDE mode: Ask] Answer questions and explain code. ' +
        'Do not modify files, create files, or apply patches unless the user explicitly asks you to edit.'
      );
    case 'plan':
      return (
        '[Hermes IDE mode: Plan] Produce a clear implementation plan with steps and trade-offs. ' +
        'Do not modify files or run mutating commands until the user switches to Agent mode.'
      );
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

export function wrapPromptForMode(mode: InteractionModeId, userText: string): string {
  const prefix = promptPrefixForMode(mode);
  if (!prefix) {
    return userText;
  }
  return `${prefix}\n\n${userText}`;
}

export type PermissionAutoAction = 'allow' | 'deny' | 'ask';

/**
 * Decide whether the host should auto-answer a permission prompt.
 * Shell / network / delete stay interactive in Agent mode.
 */
export function permissionAutoAction(
  mode: InteractionModeId,
  accessKind: string,
): PermissionAutoAction {
  const kind = (accessKind || 'other').toLowerCase();

  switch (mode) {
    case 'agent':
      if (EDIT_KINDS.has(kind) || READ_KINDS.has(kind)) {
        return 'allow';
      }
      return 'ask';
    case 'ask':
    case 'plan':
      if (EDIT_KINDS.has(kind) || DESTRUCTIVE_KINDS.has(kind)) {
        return 'deny';
      }
      if (READ_KINDS.has(kind)) {
        return 'allow';
      }
      // Shell / network still need an explicit user choice.
      return 'ask';
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

/** Prefer session-scoped allow so we do not write Hermes permanent allowlists. */
export function pickAllowOptionId(
  options: Array<{ optionId: string; kind: string }>,
): string | undefined {
  const preferred = ['allow_once', 'allow_session', 'allow_always'];
  for (const id of preferred) {
    if (options.some((o) => o.optionId === id)) {
      return id;
    }
  }
  const allowKind = options.find((o) => o.kind.startsWith('allow'));
  return allowKind?.optionId;
}

export function pickDenyOptionId(
  options: Array<{ optionId: string; kind: string }>,
): string | undefined {
  const deny = options.find(
    (o) => o.optionId === 'deny' || o.kind.startsWith('reject'),
  );
  return deny?.optionId;
}
