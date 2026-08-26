import type { Fact } from '../domain/facts';
import type { StableConfigRevision, TriggerCategory } from '../domain/config';
import type { ClientId } from '../domain/client';
import type { LaunchPlan } from '../domain/activation';
import type { ClaudeContentMaterializationResult } from '../adapters/clients/claude/content-materializer';
import type { SupplyRefRejection } from '../cli/supply-root';

/**
 * Read-only persistence port. Adapters implement this against whatever
 * storage backs it (SQLite in production); they must not make product
 * decisions -- e.g. "not found" is represented as `null`, and the
 * application layer is the one that turns that into a typed error.
 */
export interface ConfigRevisionRepository {
  listAll(): Promise<readonly StableConfigRevision[]>;
  findById(revisionId: string): Promise<StableConfigRevision | null>;
}

/**
 * `[Story 3.1]` Everything `create` needs besides the candidate itself.
 * `candidate` is intentionally `unknown` -- it is raw, untrusted JSON
 * (from `--from <path>` or stdin) that the adapter must validate field by
 * field (see `application/establish.ts`'s `parseCandidateRevision`)
 * before ever writing anything; a type mismatch anywhere must fail the
 * whole call with zero writes, never partially insert or silently coerce.
 *
 * `[Story 3.2]` `supersedesRevisionId` is required (not optional) so every
 * call site must make an explicit choice: `configs establish` always
 * passes `null` (it never replaces an existing revision); `configs revise`
 * passes the already-validated target revision id it is superseding.
 */
export interface EstablishConfigRevisionParams {
  readonly triggerCategory: TriggerCategory;
  readonly evidenceRef: string;
  readonly candidate: unknown;
  readonly supersedesRevisionId: string | null;
}

/**
 * `[Story 3.1]` Insert-only write port for `stable_config_revision` --
 * deliberately has no `update`/`delete` (Boundaries & Constraints: a
 * `StableConfigRevision` is immutable once established; a "new decision"
 * is always a new revision, never a mutation of an existing one).
 * `[Story 3.2]` `create` now accepts a non-null `supersedesRevisionId` too
 * (via `configs revise`); the port still only ever inserts a brand-new row
 * -- superseding never mutates the row it supersedes.
 */
export interface ConfigRevisionWriter {
  create(params: EstablishConfigRevisionParams): Promise<StableConfigRevision>;
}

/**
 * `[Story 3.1]` `--trigger-category` was omitted, or its value is not one
 * of the three known categories (AD-16/AD-21). Declared alongside the
 * other write-path ports/errors (same convention as `queries.ts`'s
 * `ConfigNotFoundError`) so `cli/render.ts`'s `renderQueryFailure` can fold
 * every `configs establish` rejection into the same closed
 * failure-rendering path used by `show`/`compare`.
 */
export class InvalidTriggerCategoryError extends Error {
  readonly kind = 'invalid-trigger-category' as const;

  constructor(readonly received: string | undefined) {
    super(
      `trigger category is missing or invalid (received: ${received ?? '(none)'}; expected one of new-scenario, known-insufficiency, bad-case)`,
    );
    this.name = 'InvalidTriggerCategoryError';
  }
}

/** `[Story 3.1]` `--evidence` was omitted or empty. */
export class MissingEvidenceError extends Error {
  readonly kind = 'missing-evidence' as const;

  constructor() {
    super('evidence reference is required and must be non-empty');
    this.name = 'MissingEvidenceError';
  }
}

/**
 * `[Story 3.1]` Neither `--from <path>` nor a non-TTY stdin was available
 * to read a candidate from -- rejected immediately rather than blocking on
 * an interactive stdin read (UX-DR2: non-interactive is a first-class
 * citizen).
 */
export class NoCandidateSourceError extends Error {
  readonly kind = 'no-candidate-source' as const;

  constructor() {
    super('no candidate source was provided: pass --from <path>, or pipe candidate JSON via stdin (stdin is a TTY)');
    this.name = 'NoCandidateSourceError';
  }
}

/**
 * `[Story 3.1]` The candidate (file/stdin content) could not be read,
 * parsed as JSON, or matched its declared field types.
 */
export class InvalidCandidateError extends Error {
  readonly kind = 'invalid-candidate' as const;

  constructor(readonly reason: string) {
    super(`candidate is invalid: ${reason}`);
    this.name = 'InvalidCandidateError';
  }
}

/** `[Story 3.2]` `configs revise`'s `--supersedes <revisionId>` was omitted or empty. */
export class MissingSupersedesError extends Error {
  readonly kind = 'missing-supersedes' as const;

  constructor() {
    super('supersedes target revision id is required and must be non-empty');
    this.name = 'MissingSupersedesError';
  }
}

/**
 * `[Story 3.2]` `--supersedes <revisionId>` does not identify any existing
 * revision (checked via a read-only `ConfigRevisionRepository.findById`
 * before the write port's transaction ever starts -- zero writes).
 */
export class SupersedesNotFoundError extends Error {
  readonly kind = 'supersedes-not-found' as const;

  constructor(readonly revisionId: string) {
    super(`supersedes target revision "${revisionId}" was not found`);
    this.name = 'SupersedesNotFoundError';
  }
}

/**
 * `[Story 3.2]` `--supersedes <revisionId>` identifies a revision that
 * exists but belongs to a different `configName` than the candidate being
 * revised -- checked before the write port's transaction ever starts (zero
 * writes).
 */
export class SupersedesConfigMismatchError extends Error {
  readonly kind = 'supersedes-config-mismatch' as const;

  constructor(
    readonly revisionId: string,
    readonly expectedConfigName: string,
    readonly actualConfigName: string,
  ) {
    super(
      `supersedes target revision "${revisionId}" belongs to configName "${actualConfigName}", but the candidate's configName is "${expectedConfigName}"`,
    );
    this.name = 'SupersedesConfigMismatchError';
  }
}

/**
 * `[Story 3.2]` The `--supersedes <revisionId>` target has already been
 * superseded by another revision -- surfaced as a typed error translated
 * from the `idx_stable_config_revision_supersedes_revision_id` unique
 * index conflict inside `SqliteConfigRevisionWriter.create()`'s insert
 * transaction (this closes the TOCTOU window a prior `findById` check
 * alone cannot close -- see Design Notes). The raw SQLite
 * `UNIQUE constraint failed` error must never escape past this
 * translation.
 */
export class SupersedesConflictError extends Error {
  readonly kind = 'supersedes-conflict' as const;

  constructor(readonly revisionId: string) {
    super(`supersedes target revision "${revisionId}" has already been superseded by another revision`);
    this.name = 'SupersedesConflictError';
  }
}

/**
 * `[Story 3.5]` `configs supply` 的四个 fail-closed 拒绝（AD-10）。与本文件
 * 里其余错误同样带 `kind` 判别式，因此可以并入 `cli/render.ts` 的
 * `QueryOrEstablishError` 联合，走同一条失败渲染路径，而不是让供给命令另发明
 * 一条平行的。
 *
 * 它们刻意只携带**数据**（根、组名、已经成文的原因），不携带 `SupplyRefVerdict`
 * 之类 `cli/supply-root.ts` 的类型：`application/` 不该反向依赖 `cli/`，而失败
 * 文案本身已经由产出侧用 `describeSupplyRefRejection` 生成好了。
 *
 * `defaultSupplyRoot()` 指向的目录不存在。零输出、退出 1，原因必须点名这个根
 * ——「无门可指根因」正是 Story 3.4/3.5 一路在关掉的那个问题。
 */
export class SupplyRootNotFoundError extends Error {
  readonly kind = 'supply-root-not-found' as const;

  constructor(readonly supplyRoot: string) {
    super(`supply library root does not exist or is not a directory: ${supplyRoot}`);
    this.name = 'SupplyRootNotFoundError';
  }
}

/** `[Story 3.5]` 被 `--group` 显式声明的组，在供给库里没有对应目录。 */
export class SupplyGroupNotFoundError extends Error {
  readonly kind = 'supply-group-not-found' as const;

  constructor(
    readonly group: string,
    readonly supplyRoot: string,
  ) {
    super(`supply group "${group}" was not found under supply root ${supplyRoot}`);
    this.name = 'SupplyGroupNotFoundError';
  }
}

/**
 * `[Story 3.5]` 组目录存在，却没有任何含 `SKILL.md` 的 skill 子目录。这是错误
 * 而不是空集：被显式声明却拿不到内容，静默产出零条会让下游装配出一份看起来正常、
 * 实则少了整整一个组的配置。
 */
export class SupplyGroupEmptyError extends Error {
  readonly kind = 'supply-group-empty' as const;

  constructor(
    readonly group: string,
    readonly supplyRoot: string,
  ) {
    super(`supply group "${group}" contains no skill directory with a SKILL.md under supply root ${supplyRoot}`);
    this.name = 'SupplyGroupEmptyError';
  }
}

/**
 * `[Story 3.5]` 产出自检失败：某条即将写进候选的 `sourceRef` 过不了
 * `validateSupplyRelativeRef`。
 *
 * `[P9]` 它携带的是**结构化的三元组**（原始值、当时生效的根、判定枝
 * `SupplyRefRejection`），不是一段已经成文的句子。原因是
 * `describeSupplyRefRejection` 的文案硬编码中文：直接透传会让 `CONFIGS_LANG=en`
 * 的用户读到一句中英混排。渲染改由 `cli/render.ts` 用 i18n 组装，两种语言各自
 * 成句；zh 侧的成句结果与 `describeSupplyRefRejection` **逐字相同**（有测试钉住
 * 这一点），所以「产出侧与解析侧措辞一致」这条性质没有丢，只是不再靠共用一个
 * 硬编码字符串来保证。
 */
export class SupplyRefInvalidError extends Error {
  readonly kind = 'supply-ref-invalid' as const;

  constructor(
    readonly value: string,
    readonly supplyRoot: string,
    readonly why: SupplyRefRejection,
  ) {
    super(`supply produced an invalid sourceRef (${why}): \`${value}\` against supply root \`${supplyRoot}\``);
    this.name = 'SupplyRefInvalidError';
  }
}

/**
 * `[Story 3.5 / P2]` 同一个组被声明了不止一次。判定跑在**规范化之后**，按
 * `validateSupplyRelativeRef` 返回的 `ref` 比较，而不是比原始 argv 串——
 * `--group alpha --group ./alpha` 是同一个组的两种写法，比原始串会让它穿过去，
 * 同一批 skill 被产出两遍。
 *
 * 这是**用法**错误（退出 2），不是运行期拒绝：它完全由命令行决定，与库里有什么
 * 无关。之所以仍做成典型化错误而不是在 parse 阶段判掉，是因为「两种写法是不是
 * 同一个组」这件事只有拿到供给根才答得出，而根要到 `runSupply` 才快照。
 */
export class SupplyDuplicateGroupError extends Error {
  readonly kind = 'supply-duplicate-group' as const;

  constructor(
    readonly groupRef: string,
    readonly firstDeclared: string,
    readonly secondDeclared: string,
  ) {
    super(`supply group "${groupRef}" was declared more than once (as "${firstDeclared}" and "${secondDeclared}")`);
    this.name = 'SupplyDuplicateGroupError';
  }
}

/**
 * `[Story 3.5 / P1 critical]` 两个不同的组含同名 skill。
 *
 * 为什么必须 fail-closed，而不是「产出两条、让下游自己看着办」：解析侧
 * `content-materializer.ts` 的 `materializeSkills` 用
 * `sanitizePathSegment(reference.name)` 推导目标目录，两条同名引用会先后 `cp`
 * 到**同一个** `materialized/plugin/skills/<name>`，后者覆盖前者，而
 * `failures` 仍是空数组、整次启动报告成功。这正是整套 fail-closed 设计要防的
 * 「看起来完整、实则少了内容」——而且 `configs supply` 是第一个让它容易发生的
 * 产出者：一次调用就是多个组的白名单。
 *
 * 修在产出侧，不修 `content-materializer.ts`：消费侧丢失组身份（`name` 不带组
 * 前缀）是更深的一处建模问题，已另记 defer。在它被解决之前，产出侧拒绝产出这种
 * 修订，是唯一能保证「落库的修订一定能被完整物化」的地方。
 */
export class SupplyDuplicateSkillNameError extends Error {
  readonly kind = 'supply-duplicate-skill-name' as const;

  constructor(
    readonly skillName: string,
    readonly firstSourceRef: string,
    readonly secondSourceRef: string,
  ) {
    super(
      `skill name "${skillName}" is supplied by more than one group (${firstSourceRef} and ${secondSourceRef}); materialization would silently overwrite one with the other`,
    );
    this.name = 'SupplyDuplicateSkillNameError';
  }
}

/**
 * `[Story 3.5 / P5]` 扫描或计算指纹时的 I/O 失败（`EACCES`、`EMFILE`、
 * readdir 与 readFile 之间文件被删掉的 `ENOENT`……）。
 *
 * 之所以要典型化而不是让裸 errno 逃出去：`runSupply` 只认得典型化拒绝，别的都会
 * 冒到 `import.meta.main` 的通用 `unexpectedFailure`，绕过 `renderQueryFailure`；
 * 更要紧的是，直接调 `main()` 的调用方（包括测试）拿到的会是一个 rejected
 * promise，而不是一个退出码。
 *
 * `where` 是出事的位置（组的规范化 ref，或供给根本身）——诊断必须能指到组，否则
 * 「哪个组读不动」还是要靠猜。
 */
export class SupplySourceUnreadableError extends Error {
  readonly kind = 'supply-source-unreadable' as const;

  constructor(
    readonly where: string,
    readonly supplyRoot: string,
    readonly reason: string,
  ) {
    super(`supply library could not be read at ${where} (supply root ${supplyRoot}): ${reason}`);
    this.name = 'SupplySourceUnreadableError';
  }
}

/**
 * `[Story 3.5 / P6]` skill 目录里出现了既不是普通文件也不是普通目录的项——符号
 * 链接、FIFO、设备文件之类。
 *
 * 为什么是硬拒绝而不是「跳过」：跳过会让指纹与实际交付内容不符。解析侧的 `cp`
 * 照样会把这些项复现过去（符号链接按链接复制），而指纹里没有它们；一个文件全是
 * 符号链接的 skill 甚至会哈希成**空输入**的 sha256。指纹存在的全部意义是充当
 * AD-22 退役第 (2) 步的 parity 取证依据，一个覆盖不到交付内容的指纹还不如没有。
 */
export class SupplyUnsupportedEntryError extends Error {
  readonly kind = 'supply-unsupported-entry' as const;

  constructor(
    readonly sourceRef: string,
    readonly entryPath: string,
    readonly entryKind: string,
  ) {
    super(`supply entry ${sourceRef}/${entryPath} is a ${entryKind}, which cannot be fingerprinted reproducibly`);
    this.name = 'SupplyUnsupportedEntryError';
  }
}

/**
 * Persistence port for `LaunchPlan`s. Like `ConfigRevisionRepository`,
 * adapters must not make product decisions -- "not found" is `null`; the
 * application layer turns that into a typed error.
 */
export interface LaunchPlanRepository {
  save(plan: LaunchPlan): Promise<void>;
  findById(planId: string): Promise<LaunchPlan | null>;
  /**
   * The most recently created plan for `client`, regardless of phase.
   * Used both to detect "is there something to switch away from" and to
   * resolve `configs status` when no explicit plan id is given.
   */
  findActiveForClient(client: ClientId): Promise<LaunchPlan | null>;
}

export interface OmpSpawnParams {
  readonly revision: StableConfigRevision;
  /** Path to the version-1 launch context JSON file (delivered to OMP via env, not argv). */
  readonly launchContextPath: string;
  /** Path to the thin status/switch extension file, or `null` to not load one. */
  readonly extensionPath: string | null;
  /** Opaque user-provided argv tail, passed through unparsed. */
  readonly forwardedArgs: readonly string[];
  readonly cwd: string;
}

export interface OmpSpawnResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/**
 * The only way this package ever starts or inspects the OMP binary.
 * Adapters must spawn it directly via an argv array (never a shell) --
 * see Boundaries & Constraints.
 */
export interface OmpProcessPort {
  detectVersion(): Promise<Fact<string>>;
  spawn(params: OmpSpawnParams): Promise<OmpSpawnResult>;
}

export type CapabilityProbeLevel = 'supported' | 'degraded' | 'unsupported' | 'unknown';

export interface CapabilityProbeResult {
  readonly level: CapabilityProbeLevel;
  readonly reason: string;
}

/**
 * A real, one-time detection of whether OMP's *native* interface already
 * satisfies the current-configuration/launch-status viewing contract.
 * Must never be hardcoded to skip straight to "install the extension" nor
 * to claim native support without actually probing -- see Boundaries &
 * Constraints.
 */
export interface OmpCapabilityProbePort {
  probeStatusViewingCapability(): Promise<CapabilityProbeResult>;
}

/**
 * `[Story 4.3]` A fresh-target `claude` invocation: fully-built argv (no
 * binary path -- the port resolves and prepends that itself, same as
 * `detectVersion`/`captureHelpText`), the env keys this launch needs set
 * (merged on top of the caller's own `process.env`, never replacing it --
 * same non-destructive convention as `OmpProcessPort.spawn`) and the
 * isolated `cwd` the process should run in. Never includes the launch's
 * *values* beyond what is safe to hand to a child process directly -- see
 * `adapter-plan.ts`'s Design Notes on why `ClaudeAdapterPlan` itself only
 * persists env *keys*, not this params shape.
 */
export interface ClaudeSpawnParams {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

export interface ClaudeSpawnResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/**
 * `[Story 4.1]` The only way this package ever starts or inspects the
 * `claude` (Claude Code) binary. Like `OmpProcessPort`, adapters must spawn
 * it directly via an argv array (never a shell). `captureHelpText` is the
 * probe's only source of native-surface evidence -- it returns the raw
 * `--help` output for `claude` (or a subcommand, via `args`) so capability
 * interpretation stays in the probe while process invocation stays here.
 *
 * `[Story 4.3]` `spawn` is the fresh-target launch/observe primitive
 * (AD-20's `fresh` branch): it hands full interactive stdio control to the
 * spawned `claude` process (mirrors `OmpProcessPort.spawn`) and resolves
 * only once that process has exited, with its exit code/signal -- unlike
 * `detectVersion`/`captureHelpText`, it is never subject to the probe's
 * short `timeoutMs` bound (a real interactive session is expected to run
 * for as long as the user keeps it open).
 */
export interface ClaudeProcessPort {
  detectVersion(): Promise<Fact<string>>;
  captureHelpText(args: readonly string[]): Promise<Fact<string>>;
  spawn(params: ClaudeSpawnParams): Promise<ClaudeSpawnResult>;
}

/**
 * `[Story 4.1]` Which of AD-11's independent validation tiers produced a
 * `ClaudeCapabilityProbeResult.status`. This Story's probe only ever
 * performs `mechanical` verification (static `--help` inspection) -- it
 * never spawns a real interactive session to observe an enforced effect.
 * Carrying this alongside `status` stops a downstream consumer from
 * over-reading `supported` as "Claude Code enforces this": it only means
 * "the native interface for this control still exists and matches a
 * once-verified baseline". `controlled-integration`/`real-task` results are
 * Story 4.3/4.4 territory.
 */
export type ClaudeCapabilityValidationMethod = 'mechanical' | 'controlled-integration' | 'real-task';

/**
 * `[Story 4.1]` One probed hard-control capability (AD-19's 2026-08-23
 * Epic-4 update): a stable `capabilityId`, a human-readable `subject`,
 * whether it is `required` (fail-closed) or optional (`degraded`-eligible),
 * the observed `status`, which `validationMethod` produced it, and an
 * `evidenceRef` describing what was actually observed. `evidenceRef` must
 * always describe real, captured evidence (or the reason none could be
 * captured) -- never a placeholder string. `observedAt` is when this
 * specific judgment was made (mirrors `Fact`'s own Known/Unknown timestamp
 * discipline, since this result shape is not itself a `Fact<T>`).
 */
export interface ClaudeCapabilityProbeResult {
  readonly capabilityId: string;
  readonly subject: string;
  readonly required: boolean;
  readonly status: CapabilityProbeLevel;
  readonly validationMethod: ClaudeCapabilityValidationMethod;
  readonly evidenceRef: string;
  readonly observedAt: string;
}

/**
 * `[Story 4.1]` Probes every candidate hard-control capability the Claude
 * Code adapter cares about (permission mode, MCP scoping, setting-source
 * scoping, hook deny effect -- see Design Notes). `[Story 4.5b]` Also
 * probes AD-21's two content-materialization delivery gates (`--plugin-dir`,
 * `--append-system-prompt`). Must never accept prompt text, documentation
 * claims or unverified assumptions as `supported` evidence; a capability
 * that cannot be mechanically verified resolves to `unknown`, never a
 * default `supported`.
 */
export interface ClaudeCapabilityProbePort {
  probeHardControlCapabilities(): Promise<readonly ClaudeCapabilityProbeResult[]>;
}

/**
 * The one-time, versioned file the thin OMP extension reads on
 * `session_start` (delivered via `AGENT_SYSTEM_LAUNCH_CONTEXT`). Never a
 * vehicle for task content -- see Design Notes.
 */
export interface LaunchContext {
  readonly version: 1;
  readonly planId: string;
  readonly configName: string;
  readonly revisionId: string;
  readonly client: ClientId;
  readonly launchedAt: string;
  readonly applyResult: 'applied' | 'degraded';
  readonly knownDifferences: readonly string[];
  readonly switchEntryPointHint: string;
}

export interface LaunchContextWriter {
  /** Writes the context and returns the path it was written to. */
  write(context: LaunchContext): Promise<string>;
}

/**
 * `[Story 4.3]` The Claude-adapter analogue of `LaunchContext` -- a
 * diagnostic, invocation-scoped artifact written before `claude` is
 * actually spawned (AD-9: manifest/plan/launch context are atomic,
 * immutable, per-invocation files). Unlike OMP's `LaunchContext`, no
 * running Claude Code extension reads this file today (Claude Code has no
 * equivalent extension mechanism) -- it exists purely for post-hoc human/
 * reconciliation review, named separately from `LaunchContext` so a future
 * consumer never has to guess which client a given context file shape
 * belongs to.
 */
export interface ClaudeLaunchContext {
  readonly version: 1;
  readonly planId: string;
  readonly operationId: string;
  readonly revisionId: string;
  readonly configName: string;
  readonly client: 'claude-code';
  readonly launchTarget: 'fresh';
  readonly launchedAt: string;
  readonly applyResult: 'applied' | 'degraded';
  readonly knownDifferences: readonly string[];
  readonly adapterPlanHash: string;
}

export interface ClaudeLaunchContextWriter {
  /** Writes the context and returns the path it was written to. */
  write(context: ClaudeLaunchContext): Promise<string>;
}

/**
 * `[Story 4.3]` Prepares the isolated, access-restricted per-invocation
 * directory a fresh Claude Code spawn runs in and stores its config under
 * (AD-9) -- never this repo's own root, never the user's real project or
 * global Claude Code config directory, and never `.cap/`. Returns the
 * directory's absolute path; the caller uses it as both the spawned
 * process's `cwd` and its `CLAUDE_CONFIG_DIR`, so a fresh demonstration
 * session can never read or write this repo's (or the user's) real,
 * currently-running Claude Code configuration.
 */
export interface ClaudeInvocationDirPort {
  prepare(operationId: string): Promise<string>;
  /**
   * `[Epic 4 retro fix]` Removes a previously-`prepare`d invocation
   * directory (including any AD-21 `materialized/` content under it) once
   * the launch it belonged to has reached a terminal state. Every real
   * call site already holds a `spawn()` result (which only resolves after
   * the child process has fully exited -- see `ClaudeProcessPort`'s Design
   * Notes) or never spawned a process at all, so cleanup is always safe by
   * the time it is called; never before. Best-effort and must never throw
   * -- a cleanup failure (e.g. a file still locked by an unrelated process)
   * must never mask or override the launch's real outcome.
   */
  cleanup(invocationDir: string): Promise<void>;
}

/**
 * `[Epic 4 retro fix]` AD-21's content materialization (real `fs` reads of
 * `sourceRef`-resolved content, real writes under `<invocationDir>/
 * materialized/`) as a port, matching every other real-IO collaborator
 * `application/claude-launch.ts` depends on (`ClaudeProcessPort`,
 * `ClaudeCapabilityProbePort`, `ClaudeLaunchContextWriter`,
 * `ClaudeInvocationDirPort`) -- it was the one such collaborator called
 * directly instead of through an injected port. `adapters/clients/claude/
 * content-materializer.ts`'s `FsClaudeContentMaterializer` is the real
 * implementation; its own free function (`materializeClaudeContent`) is
 * kept as the narrow, independently-testable primitive this port's
 * implementation wraps.
 */
export interface ClaudeContentMaterializerPort {
  materialize(revision: StableConfigRevision, invocationDir: string): Promise<ClaudeContentMaterializationResult>;
}

/**
 * Startup, best-effort self-update for the compiled `configs` binary
 * (Story 2.2 / AD-15's narrow self-update exception). Like every other
 * port in this file, the interface makes no product decisions -- in
 * particular `checkAndApply` must never throw: the whole
 * check/download/verify/replace chain is the adapter's responsibility to
 * fail closed on, silently, so a broken network or a corrupted download
 * never blocks or delays the command the user actually invoked.
 *
 * Returns the new version string (bare, e.g. `"1.1.0"`, no `configs-v`/`v`
 * prefix) when -- and only when -- the binary was actually replaced;
 * every other outcome (dev mode, no release, not newer, unsupported
 * platform, missing asset, checksum mismatch, or any thrown error) returns
 * `null`. The port itself makes no display decision from this value -- it
 * only reports whether/what happened; the caller (`cli/index.ts`) decides
 * whether and how to surface it.
 */
export interface SelfUpdatePort {
  checkAndApply(currentVersion: string): Promise<string | null>;
}
