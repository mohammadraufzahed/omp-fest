/**
 * Session identity for per-agent state. omp event/tool/command contexts
 * expose `sessionManager.getSessionId()`; hooks that lack it share a single
 * "default" bucket (still correct for single-session hosts).
 */
export interface SessionKeyed {
  sessionManager?: { getSessionId?(): string };
}

export function sessionIdOf(ctx: SessionKeyed): string {
  return ctx.sessionManager?.getSessionId?.() ?? "default";
}
