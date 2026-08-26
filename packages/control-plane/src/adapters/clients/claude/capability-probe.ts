import { type Fact, isKnown } from '../../../domain/facts';
import type { ClaudeCapabilityProbePort, ClaudeCapabilityProbeResult, ClaudeProcessPort } from '../../../application/ports';

/**
 * The six `permission_mode` tokens `claude --help`'s `--permission-mode`
 * option documents today, verified against a real install on this machine
 * (see Design Notes) -- and the same set `.cap/runtime/claude.toml`'s own
 * "合法取值" comment lists for its `permission_mode` field. Compared as an
 * *exact* set (see `tokenSetsEqual`) against whatever the real `--help`
 * text actually enumerates -- never a loose "does the whole blob mention
 * these words" check, and never satisfied by a superset that also lists an
 * unrecognized extra mode.
 */
const EXPECTED_PERMISSION_MODE_TOKENS: readonly string[] = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
];

/** `claude mcp add --scope <scope>` documents `(local, user, or project)`. */
const EXPECTED_MCP_SCOPE_TOKENS: readonly string[] = ['local', 'user', 'project'];

/** `claude --help`'s `--setting-sources <sources>` documents `(user, project, local)`. */
const EXPECTED_SETTING_SOURCE_TOKENS: readonly string[] = ['user', 'project', 'local'];

/** How far past a flag's own token this probe looks for its documented enum. */
const OPTION_WINDOW_SIZE = 400;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds `flagToken` in `helpText` as a real, standalone flag -- not as a
 * prefix of a longer, unrelated flag (e.g. a bare `.includes('--permission-
 * mode')` would also "find" a hypothetical `--permission-mode-legacy`).
 * Returns the text starting at the match, bounded to `OPTION_WINDOW_SIZE`
 * characters, so enum extraction only ever looks at text that actually
 * belongs to this flag's own documented choices -- never an unrelated
 * mention of the same words elsewhere in the help output.
 */
function findOptionWindow(helpText: string, flagToken: string): string | null {
  const boundaryPattern = new RegExp(`${escapeRegExp(flagToken)}(?![\\w-])`);
  const match = boundaryPattern.exec(helpText);
  if (match === null) {
    return null;
  }
  return helpText.slice(match.index, match.index + OPTION_WINDOW_SIZE);
}

/**
 * Extracts the token list from a flag's first parenthesized group, handling
 * both real `--help` enum shapes seen on this CLI: a quoted,
 * `choices: "a", "b"` form (`--permission-mode`) and a bare `a, b, or c`
 * form (`--scope`, `--setting-sources`). Returns `null` when no
 * parenthesized group is found at all -- callers must not treat that as an
 * empty-but-valid enum.
 */
function extractParenListTokens(optionWindow: string): string[] | null {
  const parenMatch = /\(([^)]*)\)/.exec(optionWindow);
  if (parenMatch === null || parenMatch[1] === undefined) {
    return null;
  }
  const inner = parenMatch[1].replace(/^\s*choices:\s*/i, '');
  const tokens = inner
    .split(/,|\bor\b/)
    .map((token) => token.trim().replace(/^"|"$/g, '').trim())
    .filter((token) => token.length > 0);
  return tokens.length > 0 ? tokens : null;
}

/** Exact set equality -- a superset (an extra, unrecognized token) is deliberately NOT equal. */
function tokenSetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setB = new Set(b);
  return a.every((token) => setB.has(token));
}

function hasFlag(helpText: string, flagToken: string): boolean {
  return findOptionWindow(helpText, flagToken) !== null;
}

function unknownResult(
  capabilityId: string,
  subject: string,
  required: boolean,
  reason: string,
  observedAt: string,
): ClaudeCapabilityProbeResult {
  return { capabilityId, subject, required, status: 'unknown', validationMethod: 'mechanical', evidenceRef: `无法验证：${reason}`, observedAt };
}

function factObservedAt(fact: Fact<string>): string {
  return isKnown(fact) ? new Date().toISOString() : fact.observedAt;
}

/**
 * Real, evidence-bound probing of Claude Code's hard-control surface (AD-19's
 * 2026-08-23 Epic-4 update, AC1). Every result is derived from `--help`
 * output actually captured via `ClaudeProcessPort` on this machine -- never
 * from prompt text, documentation claims, or an unverified assumption. A
 * capability that cannot be captured/verified resolves to `unknown`, never
 * a default `supported`. Every result's `validationMethod` is `mechanical`
 * -- this Story only ever inspects static `--help` text, never a real
 * enforced effect (that is Story 4.3/4.4's `controlled-integration` scope).
 */
export class BunClaudeCapabilityProbe implements ClaudeCapabilityProbePort {
  constructor(private readonly processPort: ClaudeProcessPort) {}

  async probeHardControlCapabilities(): Promise<readonly ClaudeCapabilityProbeResult[]> {
    const [mainHelp, mcpAddHelp] = await Promise.all([
      this.processPort.captureHelpText([]),
      this.processPort.captureHelpText(['mcp', 'add']),
    ]);

    return [
      this.probePermissionMode(mainHelp),
      this.probeMcpProjectScope(mainHelp, mcpAddHelp),
      this.probeSettingSources(mainHelp),
      this.probeHookDenyEffect(mainHelp),
      this.probePluginDirDelivery(mainHelp),
      this.probeAppendSystemPromptDelivery(mainHelp),
    ];
  }

  /**
   * Maps to `.cap/runtime/claude.toml`'s `permission_mode` field. Evidence:
   * `claude --help`'s `--permission-mode <mode>` option and its documented
   * enum, compared as an exact set.
   */
  private probePermissionMode(mainHelp: Fact<string>): ClaudeCapabilityProbeResult {
    const capabilityId = 'claude.permission-mode-control';
    const subject = 'settings/CLI 原生权限模式（permission mode）强制通道';
    const required = true;
    const observedAt = factObservedAt(mainHelp);

    if (!isKnown(mainHelp)) {
      return unknownResult(capabilityId, subject, required, mainHelp.reason, observedAt);
    }
    const optionWindow = findOptionWindow(mainHelp.value, '--permission-mode');
    if (optionWindow === null) {
      return {
        capabilityId,
        subject,
        required,
        status: 'unsupported',
        validationMethod: 'mechanical',
        evidenceRef: 'claude --help 输出未出现 --permission-mode 选项',
        observedAt,
      };
    }
    const foundTokens = extractParenListTokens(optionWindow);
    if (foundTokens !== null && tokenSetsEqual(foundTokens, EXPECTED_PERMISSION_MODE_TOKENS)) {
      return {
        capabilityId,
        subject,
        required,
        status: 'supported',
        validationMethod: 'mechanical',
        evidenceRef: `claude --help 的 --permission-mode 选项枚举与已核实基线精确一致（${EXPECTED_PERMISSION_MODE_TOKENS.join(', ')}）`,
        observedAt,
      };
    }
    return {
      capabilityId,
      subject,
      required,
      status: 'degraded',
      validationMethod: 'mechanical',
      evidenceRef: `claude --help 存在 --permission-mode 选项，但取值集合与已核实基线不完全一致（实际捕获：${foundTokens?.join(', ') ?? '（无法解析枚举）'}）`,
      observedAt,
    };
  }

  /**
   * Maps to `.cap/runtime/claude.toml`'s `enable_project_mcp` field.
   * Evidence: `claude mcp add --scope <scope>`'s documented enum (whether
   * `project` is a real, native scope) plus `claude --help`'s
   * `--strict-mcp-config` (whether project-sourced MCP servers can be
   * natively excluded from a launch).
   */
  private probeMcpProjectScope(mainHelp: Fact<string>, mcpAddHelp: Fact<string>): ClaudeCapabilityProbeResult {
    const capabilityId = 'claude.mcp-project-scope-control';
    const subject = 'MCP 服务器按 scope（local/user/project）原生隔离，用于控制项目级 MCP 是否纳入';
    const required = true;

    if (!isKnown(mainHelp)) {
      return unknownResult(capabilityId, subject, required, mainHelp.reason, mainHelp.observedAt);
    }
    if (!isKnown(mcpAddHelp)) {
      return unknownResult(capabilityId, subject, required, mcpAddHelp.reason, mcpAddHelp.observedAt);
    }

    const observedAt = new Date().toISOString();
    const hasStrictMcpConfig = hasFlag(mainHelp.value, '--strict-mcp-config');
    const scopeWindow = findOptionWindow(mcpAddHelp.value, '--scope');
    const scopeTokens = scopeWindow !== null ? extractParenListTokens(scopeWindow) : null;
    const hasProjectScope = scopeTokens !== null && tokenSetsEqual(scopeTokens, EXPECTED_MCP_SCOPE_TOKENS);

    if (hasStrictMcpConfig && hasProjectScope) {
      return {
        capabilityId,
        subject,
        required,
        status: 'supported',
        validationMethod: 'mechanical',
        evidenceRef: 'claude --help 含 --strict-mcp-config，且 claude mcp add --help 的 --scope 选项枚举与 local/user/project 精确一致',
        observedAt,
      };
    }
    if (hasStrictMcpConfig || hasProjectScope) {
      return {
        capabilityId,
        subject,
        required,
        status: 'degraded',
        validationMethod: 'mechanical',
        evidenceRef: `仅部分证据成立：--strict-mcp-config=${hasStrictMcpConfig}，--scope 枚举精确匹配=${hasProjectScope}（实际捕获：${scopeTokens?.join(', ') ?? '（未找到 --scope 选项）'}）`,
        observedAt,
      };
    }
    return {
      capabilityId,
      subject,
      required,
      status: 'unsupported',
      validationMethod: 'mechanical',
      evidenceRef: 'claude --help 与 claude mcp add --help 均未证实项目级 MCP 的原生隔离机制',
      observedAt,
    };
  }

  /**
   * Maps to `.cap/runtime/claude.toml`'s `enable_user_assets` field.
   * Evidence: `claude --help`'s `--setting-sources <sources>` (whether the
   * `user` source -- covering user-level skills/subagents/commands -- can
   * be natively excluded).
   */
  private probeSettingSources(mainHelp: Fact<string>): ClaudeCapabilityProbeResult {
    const capabilityId = 'claude.setting-sources-control';
    const subject = '按来源（user/project/local）纳入或排除配置来源的原生强制通道，覆盖用户级 skills/subagents/commands 等资产';
    const required = true;
    const observedAt = factObservedAt(mainHelp);

    if (!isKnown(mainHelp)) {
      return unknownResult(capabilityId, subject, required, mainHelp.reason, observedAt);
    }
    const optionWindow = findOptionWindow(mainHelp.value, '--setting-sources');
    if (optionWindow === null) {
      return {
        capabilityId,
        subject,
        required,
        status: 'unsupported',
        validationMethod: 'mechanical',
        evidenceRef: 'claude --help 输出未出现 --setting-sources 选项',
        observedAt,
      };
    }
    const foundTokens = extractParenListTokens(optionWindow);
    if (foundTokens !== null && tokenSetsEqual(foundTokens, EXPECTED_SETTING_SOURCE_TOKENS)) {
      return {
        capabilityId,
        subject,
        required,
        status: 'supported',
        validationMethod: 'mechanical',
        evidenceRef: `claude --help 的 --setting-sources 选项枚举与已核实来源精确一致（${EXPECTED_SETTING_SOURCE_TOKENS.join(', ')}）`,
        observedAt,
      };
    }
    return {
      capabilityId,
      subject,
      required,
      status: 'degraded',
      validationMethod: 'mechanical',
      evidenceRef: `claude --help 存在 --setting-sources 选项，但来源集合与已核实基线不完全一致（实际捕获：${foundTokens?.join(', ') ?? '（无法解析枚举）'}）`,
      observedAt,
    };
  }

  /**
   * Example capability from AC1 ("hook 拒绝返回值") that this Story
   * deliberately never resolves above `unknown`: `--help` can only confirm
   * that hook lifecycle events are a real native concept
   * (`--include-hook-events`), never that a hook's deny return value is
   * actually enforced to block an action -- that requires a real
   * controlled-integration launch observation (Story 4.3/4.4 scope), and
   * documentation claims about hook enforcement are explicitly not
   * accepted as `supported` evidence (AC1).
   */
  private probeHookDenyEffect(mainHelp: Fact<string>): ClaudeCapabilityProbeResult {
    const capabilityId = 'claude.hook-deny-return-value';
    const subject = 'hook 拒绝返回值（如非零退出码/JSON 决策）阻断动作的原生强制效果';
    const required = false;
    const observedAt = factObservedAt(mainHelp);

    if (!isKnown(mainHelp)) {
      return unknownResult(capabilityId, subject, required, mainHelp.reason, observedAt);
    }
    const hasHookLifecycleEvidence = hasFlag(mainHelp.value, '--include-hook-events');
    return {
      capabilityId,
      subject,
      required,
      status: 'unknown',
      validationMethod: 'mechanical',
      evidenceRef: hasHookLifecycleEvidence
        ? 'claude --help 仅证实 hook 生命周期事件存在（--include-hook-events），未对拒绝返回值的强制阻断效果做真实调用验证，不接受文档声称作为 supported 证据'
        : '未在 claude --help 中找到 hook 生命周期证据，且未对拒绝返回值的强制阻断效果做真实调用验证',
      observedAt,
    };
  }

  /**
   * `[Story 4.5b]` AD-21's content-materialization delivery gate for Skills:
   * a simple, `hasFlag`-style presence check (never `unknown` as a default
   * when the binary is reachable -- only `supported`/`unsupported`, exactly
   * like `probeMcpProjectScope`'s `--strict-mcp-config` half-check), because
   * this is a binary "does this argv option exist at all" fact, not a
   * multi-valued enum to compare. Required: if this machine's `claude`
   * cannot accept `--plugin-dir` at all, Skills content genuinely cannot be
   * delivered, and AD-21 says that must fail closed rather than pretend
   * otherwise.
   */
  private probePluginDirDelivery(mainHelp: Fact<string>): ClaudeCapabilityProbeResult {
    const capabilityId = 'claude.plugin-dir-delivery';
    const subject = '通过 --plugin-dir 向新 spawn 的 Claude Code 进程交付本地 plugin 包（AD-21 Skills 内容物化的唯一交付通道）';
    const required = true;
    const observedAt = factObservedAt(mainHelp);

    if (!isKnown(mainHelp)) {
      return unknownResult(capabilityId, subject, required, mainHelp.reason, observedAt);
    }
    const supported = hasFlag(mainHelp.value, '--plugin-dir');
    return {
      capabilityId,
      subject,
      required,
      status: supported ? 'supported' : 'unsupported',
      validationMethod: 'mechanical',
      evidenceRef: supported
        ? 'claude --help 输出含 --plugin-dir 选项'
        : 'claude --help 输出未出现 --plugin-dir 选项，Skills 内容物化无可用交付通道',
      observedAt,
    };
  }

  /**
   * `[Story 4.5b]` AD-21's content-materialization delivery gate for
   * Instructions -- same `hasFlag`-style presence check and same reasoning
   * as `probePluginDirDelivery`, over `--append-system-prompt` instead.
   */
  private probeAppendSystemPromptDelivery(mainHelp: Fact<string>): ClaudeCapabilityProbeResult {
    const capabilityId = 'claude.append-system-prompt-delivery';
    const subject = '通过 --append-system-prompt 向新 spawn 的 Claude Code 进程交付真实 Instructions 文本（AD-21 Instructions 内容物化的唯一交付通道）';
    const required = true;
    const observedAt = factObservedAt(mainHelp);

    if (!isKnown(mainHelp)) {
      return unknownResult(capabilityId, subject, required, mainHelp.reason, observedAt);
    }
    const supported = hasFlag(mainHelp.value, '--append-system-prompt');
    return {
      capabilityId,
      subject,
      required,
      status: supported ? 'supported' : 'unsupported',
      validationMethod: 'mechanical',
      evidenceRef: supported
        ? 'claude --help 输出含 --append-system-prompt 选项'
        : 'claude --help 输出未出现 --append-system-prompt 选项，Instructions 内容物化无可用交付通道',
      observedAt,
    };
  }
}
