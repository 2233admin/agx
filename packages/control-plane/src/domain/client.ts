/**
 * `domain/` must not import Bun, SQLite, the filesystem, or the process
 * environment. Only pure types and functions live here.
 */

/**
 * The three client identifiers this Story's CLI can be asked to launch.
 * Only `'omp'` has a working adapter in this Story -- `'claude-code'` and
 * `'codex-cli'` are named here so callers get a typed, honest "not
 * supported yet" answer instead of an unhandled string.
 */
export type ClientId = 'omp' | 'claude-code' | 'codex-cli';

/** Every `ClientId` value, in the same fixed order as the type's declaration -- for callers that must enumerate all clients (e.g. a cross-client "most recent" lookup) without duplicating the literal list. */
export const ALL_CLIENT_IDS: readonly ClientId[] = ['omp', 'claude-code', 'codex-cli'];

export interface ClientSupport {
  readonly supported: boolean;
  /** Present iff `supported` is `false`. Never a placeholder/shim excuse. */
  readonly reason?: string;
}

/**
 * MVP-FR10: `'omp'` is supported.
 *
 * `[Story 4.6]` `'claude-code'` is also supported, symmetrically with
 * `'omp'` (`{ supported: true }`, no `reason` field) -- Story 4.1~4.5b
 * already delivered a real, fail-closed Claude Code adapter (probe -> plan
 * -> launch/resume -> interpret, plus AD-21 content materialization); this
 * function does not itself perform any real detection -- it is a pure,
 * product-level "does a supported path exist for this client" switch, and
 * flipping it here is what actually lets `configs use`/`switch --client
 * claude-code` reach that adapter at all (`cli/index.ts`'s
 * `runClaudeLaunchFlow`). The real fail-closed evidence gathering happens
 * later, at `compileClaudeAssemblyManifest` time, per launch attempt --
 * exactly the same division of responsibility `'omp'` already has here.
 *
 * `'codex-cli'` remains unsupported: no adapter exists for it, and it
 * resolves to `supported: false` with a typed reason naming this as a
 * future adapter boundary -- never a placeholder implementation,
 * configuration translation or compatibility shim.
 */
export function resolveClientSupport(clientId: ClientId): ClientSupport {
  if (clientId === 'omp' || clientId === 'claude-code') {
    return { supported: true };
  }
  return {
    supported: false,
    reason: `client "${clientId}" is not supported yet -- this is a future adapter boundary, not a placeholder implementation, configuration translation or compatibility shim`,
  };
}
