import type { ClaudeAssemblyManifest, ClaudeAssemblyManifestCapabilityNote } from './assembly-manifest';

/**
 * `[Story 4.3]` The launch target this `ClaudeAdapterPlan` was compiled for
 * (AD-20). `[Story 4.4]` Now has its second member, `'already-running'`,
 * exactly as Story 4.3 predicted: adding it here forces every `switch`/
 * exhaustiveness check over `ClaudeLaunchTarget` to be revisited (see
 * `application/claude-launch.ts`'s `prepareClaudeAlreadyRunningLaunchPlan`,
 * which does so via an exhaustive `switch` on `determineClaudeLaunchTarget`'s
 * return value) rather than silently defaulting to the fresh behavior. The
 * union remains open-ended (not a bare two-member string literal type) as
 * the same kind of extension point for any future launch target.
 */
export type ClaudeLaunchTarget = 'fresh' | 'already-running';

/**
 * `[Story 4.4]` The only evidence `determineClaudeLaunchTarget` accepts as
 * proof that a launch target is the `'fresh'` spawn it is about to perform
 * itself. Deliberately a single, narrow boolean rather than a richer
 * "session info" shape -- this Story does not implement any actual
 * self-introspection/environment probing (that is Story 4.5's scope,
 * `application/claude-launch.ts`'s Never boundary); this type only exists so
 * the fail-closed judgment itself is a real, testable function instead of an
 * inline assumption baked into each call site.
 */
export interface ClaudeLaunchTargetEvidence {
  readonly ownsFreshSpawn: boolean;
}

/**
 * `[Story 4.4]` Pure, fail-closed `ClaudeLaunchTarget` determination
 * (AD-10/AD-20): only evidence that this *is* the fresh spawn itself
 * (`ownsFreshSpawn === true`) yields `'fresh'`; every other input --
 * including `false` and any future evidence shape this interface might grow
 * -- yields `'already-running'`. This asymmetry is intentional: the cost of
 * wrongly treating an already-running session as a fresh spawn (silently
 * attempting a hot-update this product cannot verify) is far higher than the
 * cost of wrongly treating a genuine fresh spawn as already-running (falling
 * back to the honest `requires-restart` path).
 */
export function determineClaudeLaunchTarget(evidence: ClaudeLaunchTargetEvidence): ClaudeLaunchTarget {
  return evidence.ownsFreshSpawn === true ? 'fresh' : 'already-running';
}

/** `[Story 4.3]` Which flag(s) a relevant, non-blocking capability contributes to the fresh-launch argv -- see Design Notes. */
const CAPABILITY_ARGV_MAP: Readonly<Record<string, readonly string[]>> = {
  // Baseline: every fresh launch is bound to the one governance-verified
  // permission mode this repo's Story 4.1 probe evidence and `.cap/
  // runtime/claude.toml` both anchor on ("manual"). The domain model
  // (`StableConfigRevision`) does not yet carry a per-revision configurable
  // policy value -- introducing one is a future Story's territory, not an
  // invention this Story should smuggle in via a fabricated default.
  'claude.permission-mode-control': ['--permission-mode', 'manual'],
  // Restricts MCP config to what this launch explicitly supplies, honoring
  // the "project-scope-only" intent this capability represents.
  'claude.mcp-project-scope-control': ['--strict-mcp-config'],
  // Restricts setting sources to the project level only, honoring `.cap`'s
  // verified `enable_user_assets:false` baseline intent (excludes `user`).
  'claude.setting-sources-control': ['--setting-sources', 'project'],
  // `claude.hook-deny-return-value` deliberately contributes no argv: Story
  // 4.1 established this capability is permanently `unknown` under
  // mechanical validation (no real hook was ever triggered) -- fabricating
  // a flag for it here would misrepresent an unverified capability as
  // enforced. See that Story's Design Notes and this Story's own residual
  // risk notes.
};

/**
 * `[Story 4.3]` Structural argv derived only from capabilities that are
 * actually relevant to this assembly (already filtered by
 * `compileClaudeAssemblyManifest`) *and* not currently blocking
 * (`supported`/`degraded` -- `unsupported`/`unknown` never reaches this
 * function for a `required` capability, since that would already have
 * blocked manifest compilation; an *optional* capability's `unsupported`/
 * `unknown` status must still never be fabricated into an enforced flag).
 * Pure and order-preserving (iterates `capabilityPolicy` as given, which
 * `compileClaudeAssemblyManifest` already produces in a fixed rule order).
 */
function isArgvContributing(note: ClaudeAssemblyManifestCapabilityNote): boolean {
  return (note.status === 'supported' || note.status === 'degraded') && CAPABILITY_ARGV_MAP[note.capabilityId] !== undefined;
}

export function buildClaudeAdapterPlanArgv(capabilityPolicy: readonly ClaudeAssemblyManifestCapabilityNote[]): string[] {
  const argv: string[] = [];
  for (const note of capabilityPolicy) {
    if (!isArgvContributing(note)) {
      continue;
    }
    argv.push(...CAPABILITY_ARGV_MAP[note.capabilityId]!);
  }
  return argv;
}

/**
 * `[Story 4.3]` The subset of `capabilityIds` that actually contributed a
 * flag to `buildClaudeAdapterPlanArgv`'s output -- i.e. the capabilities
 * genuinely *applied* to this launch attempt (as opposed to every relevant
 * capability the manifest happens to carry, which may include e.g.
 * `claude.hook-deny-return-value`: always relevant when hooks are
 * referenced, but never argv-contributing -- see `CAPABILITY_ARGV_MAP`).
 * Used by `application/claude-launch.ts` to report an honest, non-
 * overstated `affectedCapabilities` list when a spawn attempt fails or the
 * host rejects the launch (AC2): a capability that never influenced the
 * actual `claude` invocation cannot have been the thing the host rejected.
 */
export function argvContributingCapabilityIds(capabilityPolicy: readonly ClaudeAssemblyManifestCapabilityNote[]): string[] {
  return capabilityPolicy.filter(isArgvContributing).map((note) => note.capabilityId);
}

/**
 * `[Story 4.3]` Generated-file metadata only -- `purpose` names the file's
 * role; never its path (runtime/invocation-scoped, chosen at launch time by
 * `ClaudeInvocationDirPort`, never persisted here) or its content (AD-19:
 * persisted plans never carry real content, only metadata).
 *
 * `[Story 4.5b]` `'claude-plugin-dir' | 'append-system-prompt' | 'mcp-
 * config'` name AD-21's three content-materialization outputs
 * (`materialized/plugin`, the `--append-system-prompt` text, `materialized/
 * mcp.json`) purely as declared intent -- whether the assembly references
 * skills/instructions/mcp at all. Real materialization success/failure is a
 * launch-time (`launchClaudeFresh`) concern, not a compile-time one: this
 * type still carries no path or content, same as `'launch-context-
 * diagnostic'` always has.
 */
export interface ClaudeAdapterPlanGeneratedFile {
  readonly purpose: 'launch-context-diagnostic' | 'claude-plugin-dir' | 'append-system-prompt' | 'mcp-config';
}

/**
 * `[Story 4.3]` AD-19's real, launch-facing `AdapterPlan` concept -- the
 * type Story 4.2's frontmatter `deferred` entry flagged as missing (Story
 * 4.2 built the *assembly manifest* shape instead; see
 * `assembly-manifest.ts`'s Design Notes for the full resolution of that
 * naming/shape mismatch). Restricted, per AD-19, to exactly: `argv`
 * structure, environment *keys* (never real values), generated-file
 * *metadata* (never content), a deterministic `planHash`, and
 * `expectedObservation`. No secret/content-bearing field exists on this
 * type; the actual environment values and any generated file's real bytes
 * only ever exist transiently inside `launchClaudeFresh` (the ephemeral,
 * non-persisted `RuntimeLaunchSpec` AD-6 describes) and are never returned
 * from `compileClaudeAdapterPlan` or persisted anywhere.
 */
export interface ClaudeAdapterPlan {
  readonly client: 'claude-code';
  readonly launchTarget: ClaudeLaunchTarget;
  /** Ties this plan back to the exact `ClaudeAssemblyManifest` it was compiled from. */
  readonly manifestHash: string;
  readonly argv: readonly string[];
  readonly envKeys: readonly string[];
  readonly generatedFiles: readonly ClaudeAdapterPlanGeneratedFile[];
  readonly expectedObservation: {
    readonly launchTarget: ClaudeLaunchTarget;
    /** AD-8: fresh launches in this Story can reach at most `observed` (real-task validation for `verified` is out of scope). */
    readonly maxObservationStage: 'observed';
    readonly successExitCode: 0;
  };
  readonly planHash: string;
}

/**
 * Local, deterministic, non-cryptographic hash in the same
 * `Math.imul(31, hash) + charCode` style as `domain/activation.ts`'s
 * `computePlanHash` and `assembly-manifest.ts`'s
 * `computeClaudeAssemblyManifestHash` -- a separate function over a
 * separate input shape, consistent with those two files' own precedent for
 * why this is not a single shared function.
 */
function computeClaudeAdapterPlanHash(
  manifestHash: string,
  launchTarget: ClaudeLaunchTarget,
  argv: readonly string[],
  envKeys: readonly string[],
  generatedFiles: readonly ClaudeAdapterPlanGeneratedFile[],
): string {
  const input = [
    manifestHash,
    'claude-code',
    launchTarget,
    argv.join(' '),
    [...envKeys].sort().join(','),
    generatedFiles.map((file) => file.purpose).sort().join(','),
  ].join('||');

  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (Math.imul(31, hash) + input.charCodeAt(i)) | 0;
  }
  return `cadp_${(hash >>> 0).toString(16)}`;
}

/**
 * `[Story 4.3]` Pure compilation of an already-compiled `ClaudeAssemblyManifest`
 * into the real, launch-facing `ClaudeAdapterPlan` for the `fresh` target.
 * Zero IO. Always succeeds for a `compiled` manifest (there is no new
 * blocking condition at this stage -- fail-closed capability classification
 * already happened in `compileClaudeAssemblyManifest`); this function only
 * restructures already-resolved facts into the AD-19 launch shape.
 *
 * `[Story 4.5b]` `generatedFiles` now also declares AD-21's three content-
 * materialization outputs whenever the manifest's own reference groups are
 * non-empty -- declared intent only (no path/content, see
 * `ClaudeAdapterPlanGeneratedFile`'s Design Notes); this stays zero-IO and
 * still cannot fail: whether real materialization later succeeds is
 * `launchClaudeFresh`'s runtime concern, not this compile step's.
 */
export function compileClaudeAdapterPlan(manifest: ClaudeAssemblyManifest): ClaudeAdapterPlan {
  const argv = buildClaudeAdapterPlanArgv(manifest.capabilityPolicy);
  const envKeys = ['CLAUDE_CONFIG_DIR'];
  const generatedFiles: readonly ClaudeAdapterPlanGeneratedFile[] = [
    { purpose: 'launch-context-diagnostic' },
    ...(manifest.skills.length > 0 ? [{ purpose: 'claude-plugin-dir' as const }] : []),
    ...(manifest.instructions.length > 0 ? [{ purpose: 'append-system-prompt' as const }] : []),
    ...(manifest.mcp.length > 0 ? [{ purpose: 'mcp-config' as const }] : []),
  ];
  const launchTarget: ClaudeLaunchTarget = 'fresh';
  const planHash = computeClaudeAdapterPlanHash(manifest.manifestHash, launchTarget, argv, envKeys, generatedFiles);

  return {
    client: 'claude-code',
    launchTarget,
    manifestHash: manifest.manifestHash,
    argv,
    envKeys,
    generatedFiles,
    expectedObservation: { launchTarget, maxObservationStage: 'observed', successExitCode: 0 },
    planHash,
  };
}
