/**
 * Thin OMP extension, loaded via `-e <this file>` when Agent System starts
 * OMP. This file is NOT imported by the rest of this package -- OMP loads
 * it directly as a standalone module at runtime (see `process-port.ts`'s
 * `defaultExtensionPath`).
 *
 * Deliberately subscribes to `session_start` only, plus registers two
 * commands (`registerCommand`). Never subscribes to `tool_call`/
 * `tool_result`/`turn_start`/`turn_end`/`message_*`/`agent_start`/
 * `agent_end`/`before_provider_request` or any other event that would
 * observe task execution -- see Boundaries & Constraints (AR12).
 *
 * Types are inlined rather than imported from `@oh-my-pi/pi-coding-agent`
 * (Design Notes: that package's real shape was verified on a local OMP
 * 17.4.1 install, but importing it as a dependency would tie this
 * package's toolchain to OMP's moving `main`, and it is not guaranteed to
 * be installed on every dev/CI machine).
 */

interface MinimalExtensionUi {
  notify(message: string, type?: string): void;
  setStatus(key: string, text?: string): void;
}
interface MinimalExtensionContext {
  readonly ui: MinimalExtensionUi;
}

interface MinimalSessionStartEvent {
  readonly type: 'session_start';
}

interface MinimalExtensionAPI {
  on(
    event: 'session_start',
    handler: (
      event: MinimalSessionStartEvent,
      ctx: MinimalExtensionContext,
    ) => void | Promise<void>,
  ): void;
  registerCommand(
    name: string,
    opts: {
      description?: string;
      handler: (args: string[], ctx: MinimalExtensionContext) => void | Promise<void>;
    },
  ): void;
}

/** Mirrors `application/ports.ts`'s `LaunchContext` -- kept as a local, minimal shape (see file header). */
interface LaunchContextFile {
  readonly version: 1;
  readonly planId: string;
  readonly configName: string;
  readonly revisionId: string;
  readonly client: string;
  readonly launchedAt: string;
  readonly applyResult: 'applied' | 'degraded';
  readonly knownDifferences: readonly string[];
  readonly switchEntryPointHint: string;
}

/**
 * Reads the version-1 launch context file once. Never polls, watches or
 * re-reads on any event other than the caller explicitly invoking it (on
 * `session_start`, or when the user runs `/agent-config`/
 * `/agent-switch-config`) -- no background observation.
 */
async function readLaunchContext(): Promise<LaunchContextFile | null> {
  const contextPath = process.env.AGENT_SYSTEM_LAUNCH_CONTEXT;
  if (contextPath === undefined || contextPath.length === 0) {
    return null;
  }
  try {
    const text = await Bun.file(contextPath).text();
    return JSON.parse(text) as LaunchContextFile;
  } catch {
    return null;
  }
}

function formatStatusLine(context: LaunchContextFile | null): string {
  if (context === null) {
    return 'Agent System: launch context unavailable';
  }
  return `Agent System: ${context.configName}@${context.revisionId} [${context.applyResult}]`;
}

function formatDetail(context: LaunchContextFile | null): string {
  if (context === null) {
    return 'Agent System launch context is unavailable (AGENT_SYSTEM_LAUNCH_CONTEXT not set or unreadable).';
  }
  return [
    `configName: ${context.configName}`,
    `revisionId: ${context.revisionId}`,
    `client: ${context.client}`,
    `applyResult: ${context.applyResult}`,
    `knownDifferences: ${context.knownDifferences.length > 0 ? context.knownDifferences.join(', ') : '(none)'}`,
  ].join('\n');
}

export default function registerAgentStatusExtension(pi: MinimalExtensionAPI): void {
  pi.on('session_start', async (_event, ctx) => {
    const context = await readLaunchContext();
    ctx.ui.setStatus('agent-system-config', formatStatusLine(context));
  });

  pi.registerCommand('agent-config', {
    description: 'Show the Agent System configuration and launch status for this OMP session',
    handler: async (_args, ctx) => {
      const context = await readLaunchContext();
      ctx.ui.notify(formatDetail(context));
    },
  });

  pi.registerCommand('agent-switch-config', {
    description: 'Switch the Agent System configuration (forwards to the external Agent System CLI)',
    handler: async (_args, ctx) => {
      const context = await readLaunchContext();
      const hint = context?.switchEntryPointHint ?? 'run `configs switch <id>` in the Agent System CLI';
      ctx.ui.notify(`To switch configuration: ${hint}`);
    },
  });
}
