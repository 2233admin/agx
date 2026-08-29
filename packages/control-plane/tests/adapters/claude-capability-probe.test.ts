import { describe, expect, test } from 'bun:test';

import { known, unknown, type Fact } from '../../src/domain/facts';
import type { ClaudeCapabilityProbeResult, ClaudeProcessPort, ClaudeSpawnParams, ClaudeSpawnResult } from '../../src/application/ports';
import { BunClaudeCapabilityProbe } from '../../src/adapters/clients/claude/capability-probe';
import { BunClaudeProcessPort } from '../../src/adapters/clients/claude/process-port';

const REAL_MAIN_HELP = `
Options:
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --setting-sources <sources>           Comma-separated list of setting sources
                                        to load (user, project, local).
  --strict-mcp-config                   Only use MCP servers from --mcp-config,
                                        ignoring all other MCP configurations
  --include-hook-events                 Include all hook lifecycle events in the
  --plugin-dir <path>                   Load a plugin from a directory or .zip
                                        for this session only (repeatable)
  --append-system-prompt <prompt>       Append a system prompt to the default
                                        system prompt
`;

const REAL_MCP_ADD_HELP = `
Options:
  -s, --scope <scope>          Configuration scope (local, user, or project)
                               (default: "local")
`;

class FakeClaudeProcessPort implements ClaudeProcessPort {
  constructor(
    private readonly helpTexts: ReadonlyMap<string, Fact<string>>,
    private readonly version: Fact<string> = known('9.9.9'),
  ) {}

  async detectVersion(): Promise<Fact<string>> {
    return this.version;
  }

  async captureHelpText(args: readonly string[]): Promise<Fact<string>> {
    const key = args.join(' ');
    return this.helpTexts.get(key) ?? unknown(`no-fixture-for-args:${key}`, new Date().toISOString());
  }

  /** Never exercised by capability-probe tests -- Story 4.3's `claude-process-port.test.ts` covers `spawn` directly. */
  async spawn(_params: ClaudeSpawnParams): Promise<ClaudeSpawnResult> {
    throw new Error('FakeClaudeProcessPort.spawn is not exercised by capability-probe tests');
  }
}

function byId(results: readonly ClaudeCapabilityProbeResult[], id: string): ClaudeCapabilityProbeResult {
  const found = results.find((r) => r.capabilityId === id);
  if (found === undefined) {
    throw new Error(`no probe result for capabilityId ${id}`);
  }
  return found;
}

describe('BunClaudeCapabilityProbe (fixture-driven interpretation)', () => {
  test('binary unreachable: every capability resolves to unknown, never a default supported', async () => {
    const port = new FakeClaudeProcessPort(
      new Map([
        ['', unknown('claude-binary-not-found', '2026-01-01T00:00:00Z')],
        ['mcp add', unknown('claude-binary-not-found', '2026-01-01T00:00:00Z')],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(result.status).toBe('unknown');
      expect(result.evidenceRef.length).toBeGreaterThan(0);
    }
  });

  test('all real, verified evidence present: permission-mode/mcp-scope/setting-sources resolve to supported', async () => {
    const port = new FakeClaudeProcessPort(
      new Map<string, Fact<string>>([
        ['', known(REAL_MAIN_HELP)],
        ['mcp add', known(REAL_MCP_ADD_HELP)],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    expect(byId(results, 'claude.permission-mode-control').status).toBe('supported');
    expect(byId(results, 'claude.mcp-project-scope-control').status).toBe('supported');
    expect(byId(results, 'claude.setting-sources-control').status).toBe('supported');

    // `[Story 4.5b]` AD-21's content-materialization delivery gates: simple
    // presence checks, supported once the flag genuinely appears in --help.
    expect(byId(results, 'claude.plugin-dir-delivery').status).toBe('supported');
    expect(byId(results, 'claude.append-system-prompt-delivery').status).toBe('supported');

    // The hook-deny example capability is never resolved above `unknown` by
    // this Story's probe -- a real controlled-integration observation
    // (Story 4.3/4.4) is required before it could ever become `supported`.
    const hookResult = byId(results, 'claude.hook-deny-return-value');
    expect(hookResult.status).toBe('unknown');
    expect(hookResult.required).toBe(false);
  });

  test('[Story 4.5b] plugin-dir/append-system-prompt flags absent from --help: unsupported, required, never a fabricated supported', async () => {
    const helpWithoutDeliveryFlags = `
  --setting-sources <sources>           Comma-separated list of setting sources
                                        to load (user, project, local).
`;
    const port = new FakeClaudeProcessPort(
      new Map<string, Fact<string>>([
        ['', known(helpWithoutDeliveryFlags)],
        ['mcp add', known(REAL_MCP_ADD_HELP)],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    const pluginDir = byId(results, 'claude.plugin-dir-delivery');
    const appendPrompt = byId(results, 'claude.append-system-prompt-delivery');
    expect(pluginDir.status).toBe('unsupported');
    expect(pluginDir.required).toBe(true);
    expect(appendPrompt.status).toBe('unsupported');
    expect(appendPrompt.required).toBe(true);
  });

  test('permission-mode flag present but enum incomplete: degraded, not silently supported', async () => {
    const partialHelp = `
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "manual", "bypassPermissions")
`;
    const port = new FakeClaudeProcessPort(
      new Map<string, Fact<string>>([
        ['', known(partialHelp)],
        ['mcp add', known(REAL_MCP_ADD_HELP)],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    expect(byId(results, 'claude.permission-mode-control').status).toBe('degraded');
  });

  test('permission-mode flag entirely absent: unsupported, not unknown', async () => {
    const noPermissionModeHelp = `
  --setting-sources <sources>           Comma-separated list of setting sources
                                        to load (user, project, local).
`;
    const port = new FakeClaudeProcessPort(
      new Map<string, Fact<string>>([
        ['', known(noPermissionModeHelp)],
        ['mcp add', known(REAL_MCP_ADD_HELP)],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    expect(byId(results, 'claude.permission-mode-control').status).toBe('unsupported');
  });

  test('permission-mode enum is a superset (extra unrecognized mode): degraded, never silently supported', async () => {
    const supersetHelp = `
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan", "totallyNewMode")
`;
    const port = new FakeClaudeProcessPort(
      new Map<string, Fact<string>>([
        ['', known(supersetHelp)],
        ['mcp add', known(REAL_MCP_ADD_HELP)],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    expect(byId(results, 'claude.permission-mode-control').status).toBe('degraded');
  });

  test('a longer, unrelated flag that merely starts with the same prefix is not mistaken for the real flag', async () => {
    const lookalikeHelp = `
  --permission-mode-legacy <mode>       Some unrelated future flag (choices: "manual")
  --setting-sources <sources>           Comma-separated list of setting sources
                                        to load (user, project, local).
`;
    const port = new FakeClaudeProcessPort(
      new Map<string, Fact<string>>([
        ['', known(lookalikeHelp)],
        ['mcp add', known(REAL_MCP_ADD_HELP)],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    // The real `--permission-mode` flag genuinely does not exist in this
    // help text -- only a longer, unrelated lookalike does -- so this must
    // resolve to `unsupported`, never `supported`/`degraded` from a false
    // prefix match.
    expect(byId(results, 'claude.permission-mode-control').status).toBe('unsupported');
  });

  test('mcp scope fully unevidenced (neither --strict-mcp-config nor a real --scope enum): unsupported', async () => {
    const mainHelpWithoutStrictMcp = `
  --setting-sources <sources>           Comma-separated list of setting sources
                                        to load (user, project, local).
`;
    const mcpAddHelpWithoutScope = `
Options:
  -h, --help                   Display help for command
`;
    const port = new FakeClaudeProcessPort(
      new Map<string, Fact<string>>([
        ['', known(mainHelpWithoutStrictMcp)],
        ['mcp add', known(mcpAddHelpWithoutScope)],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    expect(byId(results, 'claude.mcp-project-scope-control').status).toBe('unsupported');
  });

  test('setting-sources fully unevidenced (flag absent): unsupported', async () => {
    const helpWithoutSettingSources = `
  --permission-mode <mode>              (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
`;
    const port = new FakeClaudeProcessPort(
      new Map<string, Fact<string>>([
        ['', known(helpWithoutSettingSources)],
        ['mcp add', known(REAL_MCP_ADD_HELP)],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    expect(byId(results, 'claude.setting-sources-control').status).toBe('unsupported');
  });

  test('a stray, unrelated mention of the same words elsewhere in the help text does not fabricate evidence', async () => {
    // No real --permission-mode/--setting-sources/--scope options anywhere,
    // but the enum words themselves appear scattered in unrelated prose --
    // a whole-blob substring scan would misread this as evidence.
    const noisyHelp = `
  --add-dir <directories...>   Additional directories the user may auto-manage
                                per project or local machine preference (plan
                                ahead before invoking).
`;
    const port = new FakeClaudeProcessPort(
      new Map<string, Fact<string>>([
        ['', known(noisyHelp)],
        ['mcp add', known(noisyHelp)],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    expect(byId(results, 'claude.permission-mode-control').status).toBe('unsupported');
    expect(byId(results, 'claude.setting-sources-control').status).toBe('unsupported');
    expect(byId(results, 'claude.mcp-project-scope-control').status).toBe('unsupported');
  });

  test('mcp scope only partially evidenced: degraded, not silently supported', async () => {
    const mainHelpWithoutStrictMcp = `
  --permission-mode <mode>              (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
`;
    const port = new FakeClaudeProcessPort(
      new Map<string, Fact<string>>([
        ['', known(mainHelpWithoutStrictMcp)],
        ['mcp add', known(REAL_MCP_ADD_HELP)],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    expect(byId(results, 'claude.mcp-project-scope-control').status).toBe('degraded');
  });

  test('every result carries a stable capabilityId, subject, required flag, validationMethod and observedAt', async () => {
    const port = new FakeClaudeProcessPort(
      new Map<string, Fact<string>>([
        ['', known(REAL_MAIN_HELP)],
        ['mcp add', known(REAL_MCP_ADD_HELP)],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    const ids = results.map((r) => r.capabilityId);
    expect(new Set(ids).size).toBe(ids.length); // all stable ids are unique
    for (const result of results) {
      expect(result.subject.length).toBeGreaterThan(0);
      expect(typeof result.required).toBe('boolean');
      expect(['supported', 'degraded', 'unsupported', 'unknown']).toContain(result.status);
      // This Story only ever performs static --help inspection -- never a
      // real enforced-effect observation -- so every result must say so
      // explicitly (AD-11's independent validationMethod axis), not just
      // imply it in a comment a downstream consumer might never read.
      expect(result.validationMethod).toBe('mechanical');
      expect(result.observedAt.length).toBeGreaterThan(0);
      expect(() => new Date(result.observedAt).toISOString()).not.toThrow();
    }
  });

  test('an Unknown result carries the underlying evidence gap\'s own observedAt, not a fabricated "now"', async () => {
    const port = new FakeClaudeProcessPort(
      new Map([
        ['', unknown('claude-binary-not-found', '2020-01-01T00:00:00.000Z')],
        ['mcp add', unknown('claude-binary-not-found', '2020-01-01T00:00:00.000Z')],
      ]),
    );
    const probe = new BunClaudeCapabilityProbe(port);
    const results = await probe.probeHardControlCapabilities();

    for (const result of results) {
      expect(result.observedAt).toBe('2020-01-01T00:00:00.000Z');
    }
  });
});

describe('BunClaudeCapabilityProbe (real environment)', () => {
  test('probing the real, installed claude binary (if any) never fabricates supported evidence', async () => {
    const probe = new BunClaudeCapabilityProbe(new BunClaudeProcessPort());
    const results = await probe.probeHardControlCapabilities();

    expect(results).toHaveLength(6);
    for (const result of results) {
      expect(['supported', 'degraded', 'unsupported', 'unknown']).toContain(result.status);
      expect(result.evidenceRef.length).toBeGreaterThan(0);
    }

    // hook-deny-return-value must never be reported above `unknown` by this
    // Story's static --help-only probe (AC1: no controlled-integration
    // observation has been performed).
    expect(byId(results, 'claude.hook-deny-return-value').status).toBe('unknown');

    if (Bun.which('claude') === null) {
      for (const result of results) {
        expect(result.status).toBe('unknown');
      }
    }
  });

  test('[Story 4.5b][patch] --plugin-dir/--append-system-prompt genuinely resolve to supported on this machine\'s real claude binary (AD-21\'s "must re-run probe, not reuse an old snapshot" requirement)', async () => {
    if (Bun.which('claude') === null) {
      console.warn('[Story 4.5b] claude 二进制在本环境不可达，跳过 claude.plugin-dir-delivery/claude.append-system-prompt-delivery 的真实 supported 断言。');
      return;
    }

    const probe = new BunClaudeCapabilityProbe(new BunClaudeProcessPort());
    const results = await probe.probeHardControlCapabilities();

    expect(byId(results, 'claude.plugin-dir-delivery').status).toBe('supported');
    expect(byId(results, 'claude.append-system-prompt-delivery').status).toBe('supported');
  });

  // `[Story 4.7][patch]` Restores the assertion strength `.cap/` retirement's
  // deleted `claude-capability-probe-cap-parity.test.ts` used to provide for
  // these three capabilities specifically resolving to `supported`/
  // `degraded` (not merely one of the four enum values, which the test
  // above already checks generically and which `unsupported` would also
  // satisfy). This is a pure probe-parsing regression check against real
  // `claude --help` output -- it has nothing to do with `.cap/`'s existence
  // -- and mirrors the pattern immediately above for
  // `plugin-dir-delivery`/`append-system-prompt-delivery`.
  test('[Story 4.7][patch] permission-mode/mcp-scope/setting-sources genuinely resolve to supported or degraded (never unsupported/unknown) on this machine\'s real claude binary', async () => {
    if (Bun.which('claude') === null) {
      console.warn('[Story 4.7] claude 二进制在本环境不可达，跳过 permission-mode/mcp-scope/setting-sources 的真实 supported/degraded 断言。');
      return;
    }

    const probe = new BunClaudeCapabilityProbe(new BunClaudeProcessPort());
    const results = await probe.probeHardControlCapabilities();

    expect(['supported', 'degraded']).toContain(byId(results, 'claude.permission-mode-control').status);
    expect(['supported', 'degraded']).toContain(byId(results, 'claude.mcp-project-scope-control').status);
    expect(['supported', 'degraded']).toContain(byId(results, 'claude.setting-sources-control').status);
  });
});
