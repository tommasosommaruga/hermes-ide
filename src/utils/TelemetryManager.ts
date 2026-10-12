/**
 * Telemetry is intentionally disabled in Hermes Local IDE.
 * Upstream vscode-acp used Application Insights; this fork keeps call sites as no-ops.
 */

export function initTelemetry(): { dispose(): void } {
  return { dispose() { /* no-op */ } };
}

export function sendEvent(
  _eventName: string,
  _properties?: Record<string, string>,
  _measurements?: Record<string, number>,
): void {}

export function sendError(
  _eventName: string,
  _properties?: Record<string, string>,
  _measurements?: Record<string, number>,
): void {}

export function sendException(_error: Error, _properties?: Record<string, string>): void {}
