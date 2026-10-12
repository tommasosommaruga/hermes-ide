import * as vscode from 'vscode';
import { log } from '../utils/Logger';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

/** Always prompt; dismiss → deny. Auto-approve removed. */
export class PermissionHandler {
  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const title = params.toolCall?.title || 'Permission Request';
    log(`requestPermission: ${title}`);

    const sorted = [...params.options].sort((a, b) => {
      const aDeny = a.kind.startsWith('reject') || a.optionId.startsWith('deny') ? 0 : 1;
      const bDeny = b.kind.startsWith('reject') || b.optionId.startsWith('deny') ? 0 : 1;
      return aDeny - bDeny;
    });

    const items: (vscode.QuickPickItem & { optionId: string })[] = sorted.map(option => {
      const isAllow = option.kind.startsWith('allow');
      const icon = isAllow ? '$(check)' : '$(x)';
      let detail: string | undefined;
      switch (option.optionId) {
        case 'allow_always':
          detail = 'Writes to Hermes permanent allowlist — use sparingly';
          break;
        case 'allow_session':
          detail = 'Applies only for this ACP session';
          break;
        case 'allow_once':
          detail = 'This tool call only';
          break;
        case 'deny':
        case 'deny_always':
          detail = 'Block this action';
          break;
        default:
          detail = option.kind;
          break;
      }
      return {
        label: `${icon} ${option.name}`,
        description: option.kind,
        detail,
        optionId: option.optionId,
      };
    });

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: title,
      title: 'Hermes Permission Request',
      ignoreFocusOut: true,
    });

    if (!selection) {
      const denyOption = params.options.find(
        (o) => o.optionId === 'deny' || o.kind.startsWith('reject'),
      );
      log('Permission dismissed — denying');
      if (denyOption) {
        return { outcome: { outcome: 'selected', optionId: denyOption.optionId } };
      }
      return { outcome: { outcome: 'cancelled' } };
    }

    log(`Permission selected: ${selection.optionId}`);
    return { outcome: { outcome: 'selected', optionId: selection.optionId } };
  }
}
