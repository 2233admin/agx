/**
 * Read-only adapter over a CAP-shaped directory: `manifest.toml` +
 * `profiles/*.toml` + `lock.json` (the same shape the real repo `.cap/`
 * directory used before Story 4.7 retired it). This is NOT a product CLI
 * capability -- per epics.md AR16, "configuration supply" is out of this
 * Story's scope. `configs list/show/compare` never import from this
 * module.
 *
 * `[Story 3.5]` 此前这里写的是「`configs establish`/`configs revise` 就是受支持
 * 的非交互供给路径」。那句话现在只对了一半，须更正：它们是受支持的**写**路径
 * ——把一份候选落成一条不可变修订——但它们自己不产出候选。真正的供给路径是
 * `configs supply`（`supply-fs.ts`），它按目录约定扫描供给库、产出候选 JSON，
 * 再由 `establish`/`revise` 消费。本 loader 与那条路径无关：它是一个泛化的
 * CAP 形态目录读取器，只在测试与开发脚本里出现。
 *
 * `[Story 4.7]` The real repo `.cap/` directory this loader originally read
 * has been retired (see spec-4-7-退役-cap-本体.md) -- it no longer exists on
 * disk in this repo. This module is kept because it is a generic,
 * parameterized loader over the CAP-shaped directory layout, not something
 * hardcoded to the (now-deleted) real `.cap/` path; it continues to be
 * exercised against `tests/fixtures/cap-sample/`, an equivalently-shaped
 * fixture directory, by `tests/adapters/cap-fs.test.ts` and other test
 * files in this package. `scripts/seed-from-cap.ts`, the developer-run
 * script that fed this loader with the real `.cap/` path, was deleted in
 * the same Story for the same reason.
 *
 * It never reads prompt file *contents* -- only the path string declared
 * in the profile TOML -- and it never reads credentials.
 */

import path from 'node:path';

import { type Fact, known, unknown } from '../../domain/facts';
import { validateSupplyRelativeRef } from '../../cli/supply-root';
import type { CapabilityKind, CapabilityReference, SourceCategory, StableConfigRevision } from '../../domain/config';

/**
 * `[Story 3.1]` `.cap/`-materialized revisions predate the
 * `trigger_category`/`evidence_ref`/`sourceRef`/`contentFingerprint`
 * fields this Story adds -- this loader never captured (and, per AD-20,
 * is not allowed to start capturing) any real Agent-session trigger or a
 * stronger provenance pointer than `sourceCategory` already carries. These
 * are honest `Unknown` Facts, not fabricated values, for the two new
 * per-capability fields; `evidenceRef`/`triggerCategory` on the
 * revision itself are plain (non-`Fact`) NOT NULL columns, so this uses
 * the declared manifest path as real (if approximate) evidence rather
 * than inventing a value that claims more than this loader actually knows.
 *
 * `[Story 4.5b]` `contentFingerprint` remains this honest `Unknown` for
 * every capability kind -- this loader still never hashes referenced
 * content. `sourceRef` is no longer unconditionally this value: for
 * instructions and skills, this loader already knows their real on-disk
 * path (it just used to discard that knowledge -- see AD-21's blocking
 * prerequisite) and now records it as `Known`. `mcp`/`hooks`/`plugins`
 * still have no real directory convention under `.cap/capabilities/`
 * (only `skills/` exists today), so their `sourceRef` stays this same
 * honest `Unknown` -- inventing a path for them would be fabrication, not
 * a fix (Story 4.5b's `Never` boundary).
 */
const CAP_FS_FIELD_NOT_CAPTURED = unknown('not-captured-by-cap-fs-adapter', new Date(0).toISOString());

interface CapManifest {
  version: number;
  defaults?: string;
  profiles: Record<string, string>;
}

interface CapAllowDenyOverride {
  allow?: string[];
  deny?: string[];
  override?: string[];
}

interface CapProfileToml {
  version: number;
  prompt: string;
  skills?: CapAllowDenyOverride;
  mcps?: CapAllowDenyOverride;
  hooks?: CapAllowDenyOverride;
  plugins?: CapAllowDenyOverride;
}

interface CapLockProfileInventory {
  skills: string[];
  mcps: string[];
  hooks: string[];
  plugins: string[];
}

interface CapLockProfile {
  layer_digest: string;
  inventory: CapLockProfileInventory;
}

interface CapLock {
  profiles: Record<string, CapLockProfile>;
  project_skill_imports?: Array<{ name: string; source: string }>;
}

/**
 * Declared paths inside `manifest.toml` are repo-root-relative and
 * conventionally carry a leading `.cap/` (e.g. `.cap/profiles/general.toml`)
 * even though the manifest itself lives inside `.cap/`. Resolve them
 * against `capRoot` regardless of whether that prefix is present, so this
 * works unchanged against the real repo's `.cap/` and against a
 * self-contained fixture directory that omits the prefix.
 */
function stripCapPrefix(declaredPath: string): string {
  return declaredPath.startsWith('.cap/') ? declaredPath.slice('.cap/'.length) : declaredPath;
}

function resolveCapRelativePath(capRoot: string, declaredPath: string): string {
  return path.join(capRoot, stripCapPrefix(declaredPath));
}

/**
 * `[Story 3.4]` 本 loader 产出的每一条 `sourceRef` 都必须满足跨机器可移植性
 * 合同：**库内相对 POSIX 路径**（见 `domain/config.ts` 的
 * `CapabilityReference.sourceRef`）。它此前产出的绝对路径，如今会被
 * `content-materializer.ts` fail-closed 拒掉。
 *
 * 本 loader 输出所隐含的供给根是 **`repoRoot`（`capRoot` 所在的那个目录），不是
 * `capRoot`**，而且只能如此：一条修订的全部引用必须对*同一个*根解析，而
 * CAP 形态目录里的 `project_skill_imports[].source`（例如
 * `plugins/grilling/skills/grilling`）就住在 `capRoot` *之外*。相对 `capRoot`
 * 它们只能写成 `../plugins/...`——恰恰是合同要拒绝的逃逸形态。相对 `repoRoot`，
 * 则每一条引用都留在根之内。
 *
 * `[Story 3.4 patch]` 产出侧自检，以及它为什么必须落在这个位置：声明路径会用
 * 解析侧用的同一个 `validateSupplyRelativeRef` 对 `capRoot` 校验，且在任何
 * `path.join` *之前*；不通过就降级为本 loader 别处已经在用的那个诚实
 * `Unknown`。两个细节都要紧。输入是*声明数据*，不是本模块自己的常量——一个
 * 绝对的、逃逸的（`../outside/x`）、带盘符的或分隔符反向的 profile `prompt` 或
 * `lock.json` `source`，否则就会产出一条违反合同的 `sourceRef`（win32 上甚至
 * 可能拼出「仓库根 + 另一个盘符」的怪路径）；而伪造一个坏指针，严格劣于承认这
 * 个指针未知（AD-8/AD-21 的 `Never` 边界）。至于为什么不能先 join：先 join 会
 * *掩盖*绝对路径这一情形——`path.join(root, '/abs/x')` 会欣然给出
 * `<root>/abs/x`。
 *
 * 一旦确认声明路径确实落在 `capRoot` 之内，再给它前缀上 `capRoot` 自己的名字，
 * 就足以把它变成 `repoRoot` 相对——因为 `repoRoot` 就是 `path.dirname(capRoot)`，
 * 落在其内是构造上必然的。这里刻意*不*做第二次完整校验：那次校验永远不可能触发，
 * 而一个不可达的检查就是一个会悄悄腐烂的检查。唯一一种真能破坏这次拼接的退化输入
 * ——`capRoot` 本身就是文件系统根、因而没有名字可用来做前缀——单独显式拒绝。
 *
 * `[Story 3.4 patch]` 注意这里*没有*声称的东西：产出的字符串一般**不**等同于
 * CAP 数据里声明的那个路径。`manifest.toml` 声明的是带字面 `.cap/` 前缀的
 * repo-root-relative 路径，`stripCapPrefix` 把该前缀剥掉，本函数随后又用
 * `basename(capRoot)` 重新加上前缀——两者只有在 `basename(capRoot)` 本身就是
 * `.cap`（即已退役的真实 `.cap/` 布局）时才重合。对
 * `tests/fixtures/cap-sample/` 来说，声明的 `.cap/prompts/general.md` 因此会
 * 产出 `cap-sample/prompts/general.md`。只有 `project_skill_imports[].source`
 * ——它不带 `.cap/` 前缀，本来就是 repo-root-relative——原样往返不变。
 */
function capSupplyRef(capRoot: string, declaredPath: string): Fact<string> {
  const insideCap = validateSupplyRelativeRef(stripCapPrefix(declaredPath), capRoot);
  if (!insideCap.ok) {
    return CAP_FS_FIELD_NOT_CAPTURED;
  }
  const capName = path.basename(capRoot);
  if (capName.length === 0) {
    return CAP_FS_FIELD_NOT_CAPTURED;
  }
  return known(`${capName}/${insideCap.ref}`);
}

async function readToml<T>(absPath: string): Promise<T> {
  const text = await Bun.file(absPath).text();
  return Bun.TOML.parse(text) as T;
}

async function readJson<T>(absPath: string): Promise<T> {
  const text = await Bun.file(absPath).text();
  return JSON.parse(text) as T;
}

/**
 * `[Story 4.5b]` The one already-known, never-invented real path for a
 * `skill` reference: an imported skill's real location is whatever
 * `.cap/lock.json`'s own `project_skill_imports[].source` already declares
 * (repo-root-relative, e.g. `plugins/grilling/skills/grilling`) -- resolved
 * against `repoRoot` (the directory `capRoot` lives in), not `capRoot`
 * itself, since imports live outside `.cap/`. A plain project skill (not an
 * import) lives at the one real, already-verified convention
 * `.cap/capabilities/skills/<name>/` (Story 4.5's parity evidence, captured
 * while this repo's own now-retired `.cap/capabilities/skills/*`
 * directories -- see Story 4.7 -- still existed on disk; `tests/fixtures/
 * cap-sample/` reproduces the same shape today). Never a speculative third
 * path shape.
 *
 * `[Story 3.4]` 两个分支现在都产出 `repoRoot` 相对的 POSIX 路径，而不再是绝对
 * 路径——为什么这里隐含的供给根是 `repoRoot`，见 `capSupplyRef`。*位置*没有任何
 * 变化，变的只是记录它们所用的（与机器无关的）形态。
 *
 * `[Story 3.4 patch]` 返回类型由 `Known` 放宽为 `Fact`：`lock.json` 里声明的
 * import `source` 是任意外部数据，因此一个无法表达成合法库内相对引用的值，会降级
 * 为 `mcp`/`hook`/`plugin` 已经在用的那个诚实 `Unknown`。import 分支直接校验
 * 声明字符串本身（按约定它本来就是 repo-root-relative），而不是先把它 join 到
 * `repoRoot` 上，因为 join 会掩盖「声明的是绝对路径」这一情形。
 */
function resolveSkillSourceRef(
  name: string,
  capRoot: string,
  repoRoot: string,
  importSourceByName: ReadonlyMap<string, string>,
): Fact<string> {
  const importSource = importSourceByName.get(name);
  if (importSource !== undefined) {
    const verdict = validateSupplyRelativeRef(importSource, repoRoot);
    return verdict.ok ? known(verdict.ref) : CAP_FS_FIELD_NOT_CAPTURED;
  }
  return capSupplyRef(capRoot, `capabilities/skills/${name}`);
}

/**
 * Only ever called with a non-empty `names` array when the profile actually
 * resolved in `lock.json` (see call sites: `inventory?.skills ?? []` is `[]`
 * whenever the profile is unresolved). There is therefore no "unresolved
 * capability name" case to represent here -- an unresolved profile's
 * unavailability is already carried by its `availability: Unknown(...)`.
 *
 * `[Story 4.5b]` `sourceRef` is only ever resolved to a `Known` real path for
 * `kind === 'skill'` (see `resolveSkillSourceRef`'s Design Notes on why).
 * `mcp`/`hook`/`plugin` keep the honest `CAP_FS_FIELD_NOT_CAPTURED` --
 * `.cap/capabilities/` has no `mcp/`/`hooks/`/`plugins/` directory
 * convention today (only `skills/` is real), and inventing one would be
 * fabrication, not a fix (AD-21's `Never` boundary).
 */
function mapCapabilityNames(
  names: readonly string[],
  kind: CapabilityKind,
  importNames: ReadonlySet<string>,
  importSourceByName: ReadonlyMap<string, string>,
  capRoot: string,
  repoRoot: string,
): CapabilityReference[] {
  return names.map((name) => {
    const sourceCategory: SourceCategory = importNames.has(name) ? 'project-skill-import' : 'project-capability';
    return {
      kind,
      name,
      sourceCategory: known(sourceCategory),
      summary: known(`${kind} reference: ${name}`),
      sourceRef: kind === 'skill' ? resolveSkillSourceRef(name, capRoot, repoRoot, importSourceByName) : CAP_FS_FIELD_NOT_CAPTURED,
      contentFingerprint: CAP_FS_FIELD_NOT_CAPTURED,
    };
  });
}

function buildScopeBoundary(role: string, profile: CapProfileToml): string {
  const allow = profile.skills?.allow?.length ?? 0;
  const deny = profile.skills?.deny?.length ?? 0;
  const override = profile.skills?.override?.length ?? 0;
  return `Role \`${role}\`; prompt: ${profile.prompt}; skills allow=${allow} deny=${deny} override=${override}.`;
}

/**
 * Maps `.cap/` (or an equivalently-shaped fixture directory) into
 * immutable `StableConfigRevision[]`, one per declared profile role. Field
 * mapping is fixed by the Story's frozen Design Notes and must not diverge
 * without a human renegotiating the spec.
 */
export async function loadCapConfigRevisions(capRoot: string): Promise<StableConfigRevision[]> {
  const manifest = await readToml<CapManifest>(resolveCapRelativePath(capRoot, 'manifest.toml'));
  const lock = await readJson<CapLock>(resolveCapRelativePath(capRoot, 'lock.json'));
  const importNames = new Set((lock.project_skill_imports ?? []).map((entry) => entry.name));
  // `[Story 4.5b]` `lock.json`'s own already-declared import source paths --
  // see `resolveSkillSourceRef`'s Design Notes for why this is "already
  // known, never invented" rather than a new mapping convention.
  const importSourceByName = new Map((lock.project_skill_imports ?? []).map((entry) => [entry.name, entry.source]));
  const repoRoot = path.dirname(capRoot);
  const observedAt = new Date().toISOString();

  const revisions: StableConfigRevision[] = [];

  for (const role of Object.keys(manifest.profiles)) {
    const profilePath = manifest.profiles[role];
    if (profilePath === undefined) {
      continue;
    }
    const profile = await readToml<CapProfileToml>(resolveCapRelativePath(capRoot, profilePath));
    const lockProfile = lock.profiles[role];
    const inventory = lockProfile?.inventory;
    const resolved = inventory !== undefined;

    revisions.push({
      configName: role,
      revisionId: resolved ? lockProfile!.layer_digest : `unresolved:${role}`,
      // `manifest.defaults` (e.g. ".cap/project-defaults.toml") is a path to
      // a project-level capability-policy overlay, NOT a per-profile "this
      // role is the default/generic one" marker -- there is no such role
      // identifier anywhere in declared `.cap/` data today. Per AD-8,
      // uncertain values must never be represented as `Known(false)`; this
      // must be `Unknown` for every profile until a real signal exists.
      defaultMarker: unknown('cap-manifest-defaults-field-is-not-a-per-profile-role-marker', observedAt),
      scopeBoundary: known(buildScopeBoundary(role, profile)),
      availability: resolved ? known('resolved') : unknown('not-resolved', observedAt),
      instructions: [
        {
          kind: 'instruction',
          name: profile.prompt,
          sourceCategory: known<SourceCategory>('project-prompt'),
          summary: known(`prompt file reference: ${profile.prompt}`),
          // `[Story 4.5b]` Real, already-known path -- the same one
          // `buildScopeBoundary` above already reads to build the prompt's
          // human-readable summary text; this loader was simply discarding
          // it as a provenance pointer before now (AD-21's blocking
          // prerequisite).
          //
          // `[Story 3.4]` 记录为 `repoRoot` 相对、POSIX 分隔的形态，与
          // `resolveSkillSourceRef` 用的是同一个供给根约定——一条修订，一个根。
          // 这里若是绝对路径，会被 `content-materializer.ts` fail-closed 拒掉；
          // 声明的 `prompt` 若无法合法表达，则降级为 `Unknown`，而不是产出一个
          // 注定被拒的字符串。
          sourceRef: capSupplyRef(capRoot, profile.prompt),
          contentFingerprint: CAP_FS_FIELD_NOT_CAPTURED,
        },
      ],
      skills: mapCapabilityNames(inventory?.skills ?? [], 'skill', importNames, importSourceByName, capRoot, repoRoot),
      mcp: mapCapabilityNames(inventory?.mcps ?? [], 'mcp', importNames, importSourceByName, capRoot, repoRoot),
      hooks: mapCapabilityNames(inventory?.hooks ?? [], 'hook', importNames, importSourceByName, capRoot, repoRoot),
      plugins: mapCapabilityNames(inventory?.plugins ?? [], 'plugin', importNames, importSourceByName, capRoot, repoRoot),
      // `[Story 3.1]` This loader represents "the configuration as
      // currently declared in .cap/", not an Agent-session decision to
      // establish a new revision -- none of the three trigger categories
      // genuinely fit. `new-scenario` is used as the closest available
      // placeholder (never persisted through the real write path, which
      // is `configs establish`, not this dev-only loader) and the
      // declared profile path is used as the (real, if approximate)
      // evidence reference.
      triggerCategory: 'new-scenario',
      evidenceRef: profilePath,
      supersedesRevisionId: null,
    });
  }

  return revisions;
}
