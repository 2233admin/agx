/**
 * `[Story 4.5b]` AD-21's read-only content materialization for a fresh
 * Claude Code launch: turns already-resolved `CapabilityReference.sourceRef`
 * Facts (Story 4.5b's `cap-fs.ts` fix) into real bytes written under
 * `<invocationDir>/materialized/` -- the one place this Story is allowed to
 * write inside the isolated invocation directory (never its root, which
 * doubles as `cwd`/`CLAUDE_CONFIG_DIR`).
 *
 * This module only *attempts* materialization and *reports* what happened
 * per reference -- it never decides required/optional or fail-closed vs.
 * degraded (that decision needs `ClaudeAssemblyManifest.capabilityPolicy`,
 * which this module deliberately does not import, staying a narrow,
 * independently-testable read/write primitive). `application/claude-launch.ts`
 * is the sole place that turns this result into a launch decision.
 *
 * Content never enters SQLite, a projection, a receipt or this package's
 * persisted `ClaudeAdapterPlan` (AD-6/AD-19 unchanged) -- it only ever lives
 * inside this invocation-scoped directory, which `launchClaudeFresh`
 * (`application/claude-launch.ts`) removes via `ClaudeInvocationDirPort
 * .cleanup` once the launch reaches a terminal state (AD-21).
 */
import { cp, mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

import { isKnown } from '../../../domain/facts';
import type { CapabilityReference, StableConfigRevision } from '../../../domain/config';
import { defaultSupplyRoot, describeSupplyRefRejection, validateSupplyRelativeRef } from '../../../cli/supply-root';
import { writeToSameDirTempFile } from '../../system/atomic-write';

const MATERIALIZED_DIR_NAME = 'materialized';

/** One reference (by name) that could not be materialized, and why. Never a placeholder -- always a real, described gap. */
export interface ClaudeMaterializationFailure {
  readonly name: string;
  readonly reason: string;
}

export interface ClaudeMaterializedInstructions {
  /** Concatenation (in reference order) of every successfully-read instruction text; `null` when the group is empty or nothing succeeded. */
  readonly appendSystemPromptText: string | null;
  readonly failures: readonly ClaudeMaterializationFailure[];
}

export interface ClaudeMaterializedSkills {
  /** Absolute path to `materialized/plugin` once at least one skill copied successfully; `null` when the group is empty or nothing succeeded. */
  readonly pluginDirPath: string | null;
  readonly failures: readonly ClaudeMaterializationFailure[];
}

export interface ClaudeMaterializedMcp {
  /** Absolute path to `materialized/mcp.json` once at least one server resolved successfully; `null` when the group is empty or nothing succeeded. */
  readonly mcpConfigPath: string | null;
  readonly failures: readonly ClaudeMaterializationFailure[];
}

export interface ClaudeContentMaterializationResult {
  readonly instructions: ClaudeMaterializedInstructions;
  readonly skills: ClaudeMaterializedSkills;
  readonly mcp: ClaudeMaterializedMcp;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Never a path separator or a leading-dot traversal segment -- every skill gets its own real, collision-safe subdirectory name. */
function sanitizePathSegment(name: string): string {
  const cleaned = name.replace(/[\\/]+/g, '_').replace(/^\.+/, '_');
  return cleaned.length > 0 ? cleaned : '_';
}

/**
 * `[Story 3.4]` *解析侧*把一条 `sourceRef` 变成真实路径的唯一入口——也是
 * 每次启动时强制执行跨机器可移植性裁定的地方。
 *
 * **裁定内容（AD-22 的开放歧义，就此关闭）：** `sourceRef` 只有一种合法形态
 * ——**库内相对 POSIX 路径**。它对 `supplyRoot` 解析（`cli/supply-root.ts` 中
 * 全仓共用的那个 `defaultSupplyRoot()`），而这个根是本机配置，永远不随修订
 * 走。正因为如此，同一条修订才能在两台各自以不同绝对位置复现第三方 Skill 字节
 * 的机器上都可用（AD-22）：机器差异完全由根承担。绝对路径——以及一切退化形态
 * ——一律直接拒绝，而不是留作兼容通道，因为「存在第二种被接受的形态」本身*就是*
 * AD-22 判为 critical 的那个歧义（而且没有任何真实数据用得上它：真实库里的
 * `sourceRef` 条条都是 `Unknown`）。
 *
 * 根覆盖的两种部署场景（本仓自我开发用 `CONTROL_PLANE_SUPPLY_ROOT`；发行版
 * `configs` 用户走 `$HOME` 默认值）只在 `defaultSupplyRoot()` 处写一次。判定
 * 规则本身也只活一份，在 `validateSupplyRelativeRef()` 里——本模块刻意不留副本，
 * 这样产出侧（`adapters/sources/cap-fs.ts`、Story 3.5 的供给命令）就不可能与
 * 本侧接受的形态漂移开。
 *
 * 非法一律 fail-closed（AD-10）：该引用被记为失败，绝不静默跳过；而且原因文本
 * 恒含原始 `sourceRef` 与当时生效的根——「无门可指根因」正是本 Story 要修的
 * 那个问题。
 */
function resolveSourcePath(
  reference: CapabilityReference,
  supplyRoot: string,
): { readonly path: string } | { readonly reason: string } {
  if (!isKnown(reference.sourceRef)) {
    return { reason: `sourceRef 未知：${reference.sourceRef.reason}` };
  }
  const value = reference.sourceRef.value;
  const verdict = validateSupplyRelativeRef(value, supplyRoot);
  if (!verdict.ok) {
    return { reason: describeSupplyRefRejection(value, supplyRoot, verdict.why) };
  }
  return { path: verdict.path };
}

/** AD-9's same-directory temp-file-then-rename discipline (shares its temp-write primitive with `adapters/self-update/github-release-updater.ts`'s `replaceBinary` -- see `writeToSameDirTempFile`): no reader ever observes a half-written file. */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = await writeToSameDirTempFile(filePath, content);
  await rename(tempPath, filePath);
}

async function materializeInstructions(
  references: readonly CapabilityReference[],
  supplyRoot: string,
): Promise<ClaudeMaterializedInstructions> {
  if (references.length === 0) {
    return { appendSystemPromptText: null, failures: [] };
  }

  const failures: ClaudeMaterializationFailure[] = [];
  const texts: string[] = [];

  for (const reference of references) {
    const resolved = resolveSourcePath(reference, supplyRoot);
    if ('reason' in resolved) {
      failures.push({ name: reference.name, reason: resolved.reason });
      continue;
    }
    try {
      texts.push(await readFile(resolved.path, 'utf8'));
    } catch (error) {
      failures.push({ name: reference.name, reason: `无法读取指令文件：${errorMessage(error)}` });
    }
  }

  return { appendSystemPromptText: texts.length > 0 ? texts.join('\n\n') : null, failures };
}

/**
 * Rebuilds `.cap`'s real, `--plugin-dir`-verified Claude plugin layout
 * (`openspec/changes/archive/2026-08-20-add-claude-cap-adapter/design-spec.md`'s
 * `native/plugin/` -- Claude's own plugin format, not a `.cap`-private
 * convention): `.claude-plugin/plugin.json` (`{name, version:"1.0.0",
 * description, skills:"./skills/"}`) plus one full directory copy per
 * successfully-resolved skill under `skills/<name>/` (the whole source
 * directory -- SKILL.md and any attachments, not just SKILL.md itself).
 */
async function materializeSkills(
  references: readonly CapabilityReference[],
  invocationDir: string,
  supplyRoot: string,
): Promise<ClaudeMaterializedSkills> {
  if (references.length === 0) {
    return { pluginDirPath: null, failures: [] };
  }

  const pluginDir = path.join(invocationDir, MATERIALIZED_DIR_NAME, 'plugin');
  const skillsDir = path.join(pluginDir, 'skills');
  const failures: ClaudeMaterializationFailure[] = [];
  let anySucceeded = false;

  for (const reference of references) {
    const resolved = resolveSourcePath(reference, supplyRoot);
    if ('reason' in resolved) {
      failures.push({ name: reference.name, reason: resolved.reason });
      continue;
    }
    const targetDir = path.join(skillsDir, sanitizePathSegment(reference.name));
    try {
      await cp(resolved.path, targetDir, { recursive: true });
      anySucceeded = true;
    } catch (error) {
      failures.push({ name: reference.name, reason: `无法复制 Skill 目录：${errorMessage(error)}` });
    }
  }

  if (!anySucceeded) {
    return { pluginDirPath: null, failures };
  }

  const pluginManifest = {
    name: 'agent-system-materialized-skills',
    version: '1.0.0',
    description: 'Agent System 本次 fresh 启动物化的 Skills（AD-21）',
    skills: './skills/',
  };
  try {
    await writeFileAtomic(path.join(pluginDir, '.claude-plugin', 'plugin.json'), `${JSON.stringify(pluginManifest, null, 2)}\n`);
  } catch (error) {
    // The plugin manifest itself failed to write (e.g. disk full/permission
    // denied) -- the whole plugin package is unusable even though individual
    // skill directories may have copied successfully above. Report this as a
    // failure rather than letting it propagate as an uncaught exception
    // (this function must never throw -- `launchClaudeFresh` relies on that).
    failures.push({ name: '.claude-plugin/plugin.json', reason: `无法写入 plugin.json：${errorMessage(error)}` });
    return { pluginDirPath: null, failures };
  }

  return { pluginDirPath: pluginDir, failures };
}

/** Each successfully-resolved MCP reference's file content is parsed as JSON and keyed by its reference `name` under the native `mcpServers` object. */
async function materializeMcp(
  references: readonly CapabilityReference[],
  invocationDir: string,
  supplyRoot: string,
): Promise<ClaudeMaterializedMcp> {
  if (references.length === 0) {
    return { mcpConfigPath: null, failures: [] };
  }

  const failures: ClaudeMaterializationFailure[] = [];
  const mcpServers: Record<string, unknown> = {};

  for (const reference of references) {
    const resolved = resolveSourcePath(reference, supplyRoot);
    if ('reason' in resolved) {
      failures.push({ name: reference.name, reason: resolved.reason });
      continue;
    }
    try {
      const text = await readFile(resolved.path, 'utf8');
      mcpServers[reference.name] = JSON.parse(text);
    } catch (error) {
      failures.push({ name: reference.name, reason: `无法读取/解析 MCP 服务器定义：${errorMessage(error)}` });
    }
  }

  if (Object.keys(mcpServers).length === 0) {
    return { mcpConfigPath: null, failures };
  }

  const mcpConfigPath = path.join(invocationDir, MATERIALIZED_DIR_NAME, 'mcp.json');
  try {
    await writeFileAtomic(mcpConfigPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  } catch (error) {
    // Same reasoning as `materializeSkills`'s `plugin.json` write above: never
    // let a write failure escape as an uncaught exception, even though every
    // individual MCP reference resolved/parsed successfully.
    failures.push({ name: 'mcp.json', reason: `无法写入 mcp.json：${errorMessage(error)}` });
    return { mcpConfigPath: null, failures };
  }
  return { mcpConfigPath, failures };
}

/**
 * Read-only over `revision`'s references, write-only under
 * `<invocationDir>/materialized/`. Never called before `invocationDir`
 * exists; never touches anything outside that one subdirectory.
 */
export async function materializeClaudeContent(
  revision: StableConfigRevision,
  invocationDir: string,
): Promise<ClaudeContentMaterializationResult> {
  // `[Story 3.4]` 供给根在这里**只快照一次**，然后向下传，绝不在每个引用处
  // 重读。下面三组是 `Promise.all` 并发的：一旦重读，`CONTROL_PLANE_SUPPLY_ROOT`
  // 在调用中途被改动，*同一条*修订的不同引用就会落在不同的根上。
  const supplyRoot = defaultSupplyRoot();
  const [instructions, skills, mcp] = await Promise.all([
    materializeInstructions(revision.instructions, supplyRoot),
    materializeSkills(revision.skills, invocationDir, supplyRoot),
    materializeMcp(revision.mcp, invocationDir, supplyRoot),
  ]);
  return { instructions, skills, mcp };
}

/**
 * `[Epic 4 retro fix]` Real `ClaudeContentMaterializerPort` implementation --
 * a thin wrapper so `application/claude-launch.ts` depends on the port
 * interface (`application/ports.ts`), not this module's free function
 * directly. `materializeClaudeContent` itself stays the narrow, directly
 * unit-tested primitive (`tests/adapters/claude-content-materializer.test.ts`
 * is unaffected by this wrapper).
 */
export class FsClaudeContentMaterializer {
  async materialize(revision: StableConfigRevision, invocationDir: string): Promise<ClaudeContentMaterializationResult> {
    return materializeClaudeContent(revision, invocationDir);
  }
}
