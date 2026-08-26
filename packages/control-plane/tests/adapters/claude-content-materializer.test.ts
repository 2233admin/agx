/**
 * `[Story 3.4]` 本文件里的每一条 `sourceRef` 都是**库内相对 POSIX 路径**，对
 * `CONTROL_PLANE_SUPPLY_ROOT` 解析（在 `beforeEach` 里指向一个真实的
 * `mkdtemp` 目录）。这是唯一合法形态；这些测试在 Story 3.4 之前用的绝对
 * `mkdtemp` 路径现在会被 fail-closed 拒掉，下面的矩阵断言的正是这件事。
 *
 * 环境变量纪律：覆盖值是**保存并恢复**的，不是只 `delete`，因此本文件不可能把
 * 一个根泄漏给任何别的测试文件（`tests/cli/supply-root.test.ts` 保持同一纪律）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { materializeClaudeContent } from '../../src/adapters/clients/claude/content-materializer';
import { SUPPLY_REF_REJECTION_MARKER } from '../../src/cli/supply-root';
import type { CapabilityReference } from '../../src/domain/config';
import { known, unknown } from '../../src/domain/facts';

let sourceDir: string;
let invocationDir: string;
let originalSupplyRoot: string | undefined;

beforeEach(() => {
  sourceDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-claude-materializer-src-'));
  invocationDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-claude-materializer-inv-'));
  originalSupplyRoot = process.env.CONTROL_PLANE_SUPPLY_ROOT;
  process.env.CONTROL_PLANE_SUPPLY_ROOT = sourceDir;
});

afterEach(() => {
  if (originalSupplyRoot === undefined) {
    delete process.env.CONTROL_PLANE_SUPPLY_ROOT;
  } else {
    process.env.CONTROL_PLANE_SUPPLY_ROOT = originalSupplyRoot;
  }
  rmSync(sourceDir, { recursive: true, force: true });
  rmSync(invocationDir, { recursive: true, force: true });
});

function ref(kind: CapabilityReference['kind'], name: string, sourceRef: CapabilityReference['sourceRef']): CapabilityReference {
  return {
    kind,
    name,
    sourceCategory: known('project-capability'),
    summary: known(`${kind}: ${name}`),
    sourceRef,
    contentFingerprint: unknown('not-captured-by-cap-fs-adapter', new Date(0).toISOString()),
  };
}

/** 在当前供给根下写出真实的 skill 目录，返回它的**库内相对 POSIX** `sourceRef`。 */
function writeRealSkillDir(name: string, files: Record<string, string>, root: string = sourceDir): string {
  const dir = path.join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    const filePath = path.join(dir, fileName);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  }
  return `skills/${name}`;
}

/** 在当前供给根下写出真实文件，返回它的**库内相对 POSIX** `sourceRef`。 */
function writeRealFile(name: string, content: string, root: string = sourceDir): string {
  writeFileSync(path.join(root, name), content, 'utf8');
  return name;
}

describe('materializeClaudeContent', () => {
  test('empty revision (no references at all): every group is null with zero failures, nothing written', async () => {
    const result = await materializeClaudeContent(
      {
        configName: 'general',
        revisionId: 'rev-empty',
        defaultMarker: known(false),
        scopeBoundary: known('scope'),
        availability: known('resolved'),
        instructions: [],
        skills: [],
        mcp: [],
        hooks: [],
        plugins: [],
        triggerCategory: 'new-scenario',
        evidenceRef: 'test',
        supersedesRevisionId: null,
      },
      invocationDir,
    );

    expect(result.instructions).toEqual({ appendSystemPromptText: null, failures: [] });
    expect(result.skills).toEqual({ pluginDirPath: null, failures: [] });
    expect(result.mcp).toEqual({ mcpConfigPath: null, failures: [] });
    expect(existsSync(path.join(invocationDir, 'materialized'))).toBe(false);
  });

  test('instructions: a real, readable sourceRef is read out verbatim and never written to disk', async () => {
    const promptRef = writeRealFile('general.md', '# General role prompt\n\nBe helpful.');
    const result = await materializeClaudeContent(
      revisionWith({ instructions: [ref('instruction', 'general.md', known(promptRef))] }),
      invocationDir,
    );

    expect(result.instructions.failures).toEqual([]);
    expect(result.instructions.appendSystemPromptText).toBe('# General role prompt\n\nBe helpful.');
    // Instructions text is handed back as a value, never written under materialized/.
    expect(existsSync(path.join(invocationDir, 'materialized'))).toBe(false);
  });

  test('instructions: multiple references concatenate in order, separated by a blank line', async () => {
    const p1 = writeRealFile('a.md', 'first');
    const p2 = writeRealFile('b.md', 'second');
    const result = await materializeClaudeContent(
      revisionWith({ instructions: [ref('instruction', 'a.md', known(p1)), ref('instruction', 'b.md', known(p2))] }),
      invocationDir,
    );

    expect(result.instructions.appendSystemPromptText).toBe('first\n\nsecond');
    expect(result.instructions.failures).toEqual([]);
  });

  test('instructions: Unknown sourceRef is reported as a failure, never a placeholder', async () => {
    const result = await materializeClaudeContent(
      revisionWith({ instructions: [ref('instruction', 'missing.md', unknown('not-captured-by-cap-fs-adapter', '2026-01-01T00:00:00Z'))] }),
      invocationDir,
    );

    expect(result.instructions.appendSystemPromptText).toBeNull();
    expect(result.instructions.failures).toHaveLength(1);
    expect(result.instructions.failures[0]!.name).toBe('missing.md');
    expect(result.instructions.failures[0]!.reason).toContain('sourceRef');
  });

  test('instructions: a Known sourceRef pointing at a file that does not exist under the supply root is reported as a failure', async () => {
    const result = await materializeClaudeContent(
      revisionWith({ instructions: [ref('instruction', 'ghost.md', known('does-not-exist.md'))] }),
      invocationDir,
    );

    expect(result.instructions.appendSystemPromptText).toBeNull();
    expect(result.instructions.failures).toHaveLength(1);
    expect(result.instructions.failures[0]!.name).toBe('ghost.md');
  });

  test('skills: a real, readable sourceRef directory is fully copied under materialized/plugin/skills/<name>/, and .claude-plugin/plugin.json is written', async () => {
    const skillRef = writeRealSkillDir('openspec-explore', { 'SKILL.md': '# openspec-explore\n\nDo the thing.' });
    const result = await materializeClaudeContent(revisionWith({ skills: [ref('skill', 'openspec-explore', known(skillRef))] }), invocationDir);

    expect(result.skills.failures).toEqual([]);
    expect(result.skills.pluginDirPath).toBe(path.join(invocationDir, 'materialized', 'plugin'));

    const copiedSkillMd = path.join(invocationDir, 'materialized', 'plugin', 'skills', 'openspec-explore', 'SKILL.md');
    expect(existsSync(copiedSkillMd)).toBe(true);
    expect(readFileSync(copiedSkillMd, 'utf8')).toBe('# openspec-explore\n\nDo the thing.');

    const pluginJsonPath = path.join(invocationDir, 'materialized', 'plugin', '.claude-plugin', 'plugin.json');
    expect(existsSync(pluginJsonPath)).toBe(true);
    const pluginManifest = JSON.parse(readFileSync(pluginJsonPath, 'utf8'));
    expect(pluginManifest).toEqual({
      name: 'agent-system-materialized-skills',
      version: '1.0.0',
      description: expect.any(String),
      skills: './skills/',
    });
  });

  test('skills: copies the whole source directory (attachments alongside SKILL.md), not just SKILL.md', async () => {
    const skillRef = writeRealSkillDir('grilling', {
      'SKILL.md': '# grilling',
      'agents/openai.yaml': 'name: grilling',
    });
    const result = await materializeClaudeContent(revisionWith({ skills: [ref('skill', 'grilling', known(skillRef))] }), invocationDir);

    expect(result.skills.failures).toEqual([]);
    const attachmentPath = path.join(invocationDir, 'materialized', 'plugin', 'skills', 'grilling', 'agents', 'openai.yaml');
    expect(existsSync(attachmentPath)).toBe(true);
    expect(readFileSync(attachmentPath, 'utf8')).toBe('name: grilling');
  });

  test('[patch] skills: plugin.json write failure (a colliding file blocks .claude-plugin/) is reported as a failure, never thrown', async () => {
    const skillRef = writeRealSkillDir('openspec-explore', { 'SKILL.md': 'real content' });
    // Pre-create `materialized/plugin/.claude-plugin` as a plain *file* --
    // the skill copy itself (a sibling `skills/<name>/` subtree) still
    // succeeds, but the subsequent `mkdir(.../.claude-plugin, {recursive})`
    // for `plugin.json` fails because that exact path already exists as a
    // non-directory.
    mkdirSync(path.join(invocationDir, 'materialized', 'plugin'), { recursive: true });
    writeFileSync(path.join(invocationDir, 'materialized', 'plugin', '.claude-plugin'), 'not a directory', 'utf8');

    const result = await materializeClaudeContent(
      revisionWith({ skills: [ref('skill', 'openspec-explore', known(skillRef))] }),
      invocationDir,
    );

    // The skill directory itself really did copy...
    expect(existsSync(path.join(invocationDir, 'materialized', 'plugin', 'skills', 'openspec-explore', 'SKILL.md'))).toBe(true);
    // ...but the whole plugin package is reported unusable (no plugin.json
    // manifest, no `--plugin-dir` delivery) rather than silently succeeding
    // with an incomplete package or throwing an uncaught exception.
    expect(result.skills.pluginDirPath).toBeNull();
    expect(result.skills.failures.some((f) => f.name === '.claude-plugin/plugin.json')).toBe(true);
  });

  test('skills: multiple references, one Unknown sourceRef -- the resolvable one still materializes, the failure is reported, no placeholder content is fabricated', async () => {
    const skillRef = writeRealSkillDir('openspec-explore', { 'SKILL.md': 'real content' });
    const result = await materializeClaudeContent(
      revisionWith({
        skills: [
          ref('skill', 'openspec-explore', known(skillRef)),
          ref('skill', 'ghost-skill', unknown('not-captured-by-cap-fs-adapter', '2026-01-01T00:00:00Z')),
        ],
      }),
      invocationDir,
    );

    expect(result.skills.pluginDirPath).toBe(path.join(invocationDir, 'materialized', 'plugin'));
    expect(result.skills.failures).toHaveLength(1);
    expect(result.skills.failures[0]!.name).toBe('ghost-skill');
    expect(existsSync(path.join(invocationDir, 'materialized', 'plugin', 'skills', 'openspec-explore', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(invocationDir, 'materialized', 'plugin', 'skills', 'ghost-skill'))).toBe(false);
  });

  test('skills: every reference unresolvable -- pluginDirPath stays null, nothing is written under materialized/', async () => {
    const result = await materializeClaudeContent(
      revisionWith({ skills: [ref('skill', 'ghost-skill', unknown('not-captured-by-cap-fs-adapter', '2026-01-01T00:00:00Z'))] }),
      invocationDir,
    );

    expect(result.skills.pluginDirPath).toBeNull();
    expect(result.skills.failures).toHaveLength(1);
    expect(existsSync(path.join(invocationDir, 'materialized', 'plugin', '.claude-plugin', 'plugin.json'))).toBe(false);
  });

  test('skills: a name containing path separators is sanitized into a single safe path segment, never escaping skills/', async () => {
    // 这条测的是*写*侧（对引用 `name` 调 `sanitizePathSegment`），不是读侧的
    // 供给根收敛——这里的 `sourceRef` 本身是一条完全合法的相对路径。
    const skillRef = writeRealSkillDir('weird', { 'SKILL.md': 'x' });
    const result = await materializeClaudeContent(
      revisionWith({ skills: [ref('skill', '../../escape', known(skillRef))] }),
      invocationDir,
    );

    expect(result.skills.failures).toEqual([]);
    const skillsRoot = path.join(invocationDir, 'materialized', 'plugin', 'skills');
    const entries = readdirSync(skillsRoot);
    for (const entry of entries) {
      expect(path.resolve(skillsRoot, entry).startsWith(path.resolve(skillsRoot))).toBe(true);
    }
  });

  test('mcp: a real, readable sourceRef JSON file is parsed and keyed by reference name under mcpServers, written to materialized/mcp.json', async () => {
    const mcpDefRef = writeRealFile('some-mcp.json', JSON.stringify({ command: 'node', args: ['server.js'] }));
    const result = await materializeClaudeContent(revisionWith({ mcp: [ref('mcp', 'some-mcp', known(mcpDefRef))] }), invocationDir);

    expect(result.mcp.failures).toEqual([]);
    expect(result.mcp.mcpConfigPath).toBe(path.join(invocationDir, 'materialized', 'mcp.json'));
    const written = JSON.parse(readFileSync(result.mcp.mcpConfigPath!, 'utf8'));
    expect(written).toEqual({ mcpServers: { 'some-mcp': { command: 'node', args: ['server.js'] } } });
  });

  test('[patch] mcp: mcp.json write failure (a colliding file blocks materialized/) is reported as a failure, never thrown', async () => {
    const mcpDefRef = writeRealFile('some-mcp.json', JSON.stringify({ command: 'node', args: ['server.js'] }));
    // Pre-create `materialized` itself as a plain *file* -- every MCP
    // reference resolves/parses fine (no fs write happens until the final
    // `mcp.json` write), but that final write's own
    // `mkdir(materialized/, {recursive})` fails because `materialized`
    // already exists as a non-directory.
    writeFileSync(path.join(invocationDir, 'materialized'), 'not a directory', 'utf8');

    const result = await materializeClaudeContent(revisionWith({ mcp: [ref('mcp', 'some-mcp', known(mcpDefRef))] }), invocationDir);

    expect(result.mcp.mcpConfigPath).toBeNull();
    expect(result.mcp.failures.some((f) => f.name === 'mcp.json')).toBe(true);
  });

  test('mcp: Unknown sourceRef (today\'s real .cap/ state -- cap-fs.ts never resolves mcp sourceRef) is reported as a failure, mcpConfigPath stays null', async () => {
    const result = await materializeClaudeContent(
      revisionWith({ mcp: [ref('mcp', 'some-mcp', unknown('not-captured-by-cap-fs-adapter', '2026-01-01T00:00:00Z'))] }),
      invocationDir,
    );

    expect(result.mcp.mcpConfigPath).toBeNull();
    expect(result.mcp.failures).toHaveLength(1);
    expect(result.mcp.failures[0]!.name).toBe('some-mcp');
    expect(existsSync(path.join(invocationDir, 'materialized', 'mcp.json'))).toBe(false);
  });

  test('mcp: a real file that is not valid JSON is reported as a failure, not silently skipped', async () => {
    const badRef = writeRealFile('bad-mcp.json', 'not json{{{');
    const result = await materializeClaudeContent(revisionWith({ mcp: [ref('mcp', 'bad-mcp', known(badRef))] }), invocationDir);

    expect(result.mcp.mcpConfigPath).toBeNull();
    expect(result.mcp.failures).toHaveLength(1);
    expect(result.mcp.failures[0]!.name).toBe('bad-mcp');
  });

  test('never writes anything at the invocation directory root -- only ever under materialized/', async () => {
    const skillRef = writeRealSkillDir('openspec-explore', { 'SKILL.md': 'x' });
    const promptRef = writeRealFile('general.md', 'prompt text');
    await materializeClaudeContent(
      revisionWith({
        instructions: [ref('instruction', 'general.md', known(promptRef))],
        skills: [ref('skill', 'openspec-explore', known(skillRef))],
      }),
      invocationDir,
    );

    const rootEntries = readdirSync(invocationDir);
    expect(rootEntries).toEqual(['materialized']);
  });
});

/**
 * `[Story 3.4]` 冻结区 I/O & Edge-Case Matrix，逐行覆盖。每一种被拒形态都必须
 * fail-closed（AD-10），*并且*同时点名出问题的 `sourceRef` 值与当时生效的根
 * ——「无门可指根因」正是本 Story 关闭的那个问题。
 */
describe('[Story 3.4] sourceRef 只接受库内相对路径：非法形态一律 fail-closed', () => {
  async function skillFailure(sourceRefValue: string): Promise<{ readonly reason: string; readonly pluginDirPath: string | null }> {
    const result = await materializeClaudeContent(
      revisionWith({ skills: [ref('skill', 'some-skill', known(sourceRefValue))] }),
      invocationDir,
    );
    expect(result.skills.failures).toHaveLength(1);
    return { reason: result.skills.failures[0]!.reason, pluginDirPath: result.skills.pluginDirPath };
  }

  /**
   * `[Story 3.4 patch]` 只断言「原因里提到了值和根」是不够强的：下游的
   * `ENOENT` 同样会点名解析后的路径，于是某条规则悄悄不再触发（比如反斜杠拒绝
   * 变成只在 win32 生效）时，两条 CI 腿依旧全绿——而跨平台一致恰恰是那条规则存在
   * 的全部理由。所以每一次拒绝还必须带上合同标记*以及*具体触发的那条规则；
   * `ENOENT`/`EISDIR`/JSON 解析失败的消息里不可能出现其中任何一个。
   */
  function expectContractRejection(reason: string, sourceRefValue: string, why: string): void {
    expect(reason).toContain(SUPPLY_REF_REJECTION_MARKER);
    expect(reason).toContain(why);
    expect(reason).toContain(sourceRefValue);
    expect(reason).toContain(sourceDir);
  }

  test('合法相对路径解析为 <root>/<value> 并真的物化', async () => {
    const skillRef = writeRealSkillDir('a', { 'SKILL.md': 'a' });
    expect(skillRef).toBe('skills/a');
    const result = await materializeClaudeContent(revisionWith({ skills: [ref('skill', 'a', known(skillRef))] }), invocationDir);
    expect(result.skills.failures).toEqual([]);
    expect(existsSync(path.join(invocationDir, 'materialized', 'plugin', 'skills', 'a', 'SKILL.md'))).toBe(true);
  });

  test('空串：path.resolve 会返回供给根本身，必须拒绝（否则整个供给库被当成一个 Skill 拷入并报成功）', async () => {
    const { reason, pluginDirPath } = await skillFailure('');
    expect(pluginDirPath).toBeNull();
    expectContractRejection(reason, '', '为空');
    expect(existsSync(path.join(invocationDir, 'materialized'))).toBe(false);
  });

  test('当前目录 `.`：同样解析为供给根本身，拒绝', async () => {
    const { reason, pluginDirPath } = await skillFailure('.');
    expect(pluginDirPath).toBeNull();
    expectContractRejection(reason, '.', '解析后未落在供给根之内');
    expect(existsSync(path.join(invocationDir, 'materialized'))).toBe(false);
  });

  test('逃逸 `..`：解析到供给根之外，拒绝', async () => {
    const { reason, pluginDirPath } = await skillFailure('..');
    expect(pluginDirPath).toBeNull();
    expectContractRejection(reason, '..', '解析后未落在供给根之内');
  });

  test('逃逸 `../x`：解析到供给根之外，拒绝', async () => {
    const { reason, pluginDirPath } = await skillFailure('../x');
    expect(pluginDirPath).toBeNull();
    expectContractRejection(reason, '../x', '解析后未落在供给根之内');
  });

  test('反斜杠：win32 可解析但 POSIX 上会塌成单个文件名，两处含义不同，拒绝', async () => {
    // `<root>/skills/a` 处确实存在一个真实目录，所以在 win32 上这条本来会静默
    // 成功——两个平台的这种分歧正是重点。
    writeRealSkillDir('a', { 'SKILL.md': 'a' });
    const value = 'skills\\a';
    const { reason, pluginDirPath } = await skillFailure(value);
    expect(pluginDirPath).toBeNull();
    expectContractRejection(reason, value, '含反斜杠');
    expect(existsSync(path.join(invocationDir, 'materialized'))).toBe(false);
  });

  test('绝对（POSIX 风格）`/x/y`：拒绝', async () => {
    const { reason, pluginDirPath } = await skillFailure('/x/y');
    expect(pluginDirPath).toBeNull();
    expectContractRejection(reason, '/x/y', '是绝对路径');
  });

  test('绝对（真实 mkdtemp 路径，Story 3.4 之前的形态）：拒绝', async () => {
    writeRealSkillDir('a', { 'SKILL.md': 'a' });
    const value = path.join(sourceDir, 'skills', 'a');
    const { reason, pluginDirPath } = await skillFailure(value);
    expect(pluginDirPath).toBeNull();
    // win32 的临时路径是反斜杠分隔的，所以那边触发的是第 (2) 条规则，POSIX 上
    // 触发的是第 (4) 条——无论哪条，它都是一次*合同*拒绝，这才是要断言的东西。
    expectContractRejection(reason, value, process.platform === 'win32' ? '含反斜杠' : '是绝对路径');
    expect(existsSync(path.join(invocationDir, 'materialized'))).toBe(false);
  });

  /**
   * `[Story 3.4 patch]` 现在第 (3) 条规则用模式匹配拒绝 `X:` 前缀、而不是把它
   * 交给 `path` 语义，这几行盘符用例因此变得**与平台无关**。它们此前之所以是
   * win32 专属，恰恰是因为两个平台在这里不一致——那是 bug，不是要保留的性质：
   * `C:/x/y` 在 win32 上是绝对路径，在 POSIX 上只是个普通相对名；`C:x/y` 在
   * win32 上是盘符相对，在 POSIX 上却是个字面叫 `C:x` 的目录。两条 CI 腿
   * （ubuntu、windows）都会跑齐这三行。
   */
  test('绝对（带盘符）`C:/x/y`：带盘符前缀，两个平台一致拒绝', async () => {
    const { reason, pluginDirPath } = await skillFailure('C:/x/y');
    expect(pluginDirPath).toBeNull();
    expectContractRejection(reason, 'C:/x/y', '带盘符前缀');
  });

  test('盘符相对 `<其他盘>:x/y`：带盘符前缀，拒绝', async () => {
    // 冻结区矩阵实测这一行时，根取在 `D:` 上——与引用里的盘符是*不同*的盘，这正是
    // win32 上让 `path.resolve` 回退到该盘自己的 cwd、从而落到根外的原因。这里同样
    // 推导出一个不等于根所在盘的盘符。
    const rootDrive = process.platform === 'win32' ? path.parse(sourceDir).root.slice(0, 1).toUpperCase() : 'C';
    const otherDrive = rootDrive === 'Z' ? 'Y' : 'Z';
    const value = `${otherDrive}:x/y`;
    const { reason, pluginDirPath } = await skillFailure(value);
    expect(pluginDirPath).toBeNull();
    expectContractRejection(reason, value, '带盘符前缀');
  });

  test('盘符相对且与供给根同盘 `<根所在盘>:x/y`：曾是唯一会被接受的盘符形态（win32 会把它折进根内），现在同样拒绝', async () => {
    // 这就是第 (3) 条规则存在的理由。当根在同一个盘上时，win32 的
    // `path.resolve` 会拿*根*当基准来解析这个盘符相对值，于是它落在
    // `<root>/x/y`——在根之内，也就是能通过收敛检查——而在 POSIX 上，同一条修订
    // 指的却是一个叫 `<root>/C:x/y` 的目录。一条修订，两种含义。
    const rootDrive = process.platform === 'win32' ? path.parse(sourceDir).root.slice(0, 1).toUpperCase() : 'C';
    const value = `${rootDrive}:x/y`;
    const { reason, pluginDirPath } = await skillFailure(value);
    expect(pluginDirPath).toBeNull();
    expectContractRejection(reason, value, '带盘符前缀');
    expect(existsSync(path.join(invocationDir, 'materialized'))).toBe(false);
  });

  test('根内以点开头的合法目录名（`..x`/`...notes`）不被收敛检查误伤', async () => {
    // 对这些名字 `path.relative()` 返回的就是 `..x`，所以只写
    // `startsWith('..')` 的谓词会误拒根内完全合法的目录。它们必须能正常物化。
    mkdirSync(path.join(sourceDir, '..x'), { recursive: true });
    writeFileSync(path.join(sourceDir, '..x', 'SKILL.md'), 'dot-prefixed', 'utf8');
    const result = await materializeClaudeContent(
      revisionWith({ skills: [ref('skill', 'dotty', known('..x'))] }),
      invocationDir,
    );
    expect(result.skills.failures).toEqual([]);
    expect(readFileSync(path.join(result.skills.pluginDirPath!, 'skills', 'dotty', 'SKILL.md'), 'utf8')).toBe('dot-prefixed');
  });

  test('instructions/mcp 两组走的是同一个收敛点，同样 fail-closed 且原因含值与根', async () => {
    const result = await materializeClaudeContent(
      revisionWith({
        instructions: [ref('instruction', 'bad-instruction', known('..'))],
        mcp: [ref('mcp', 'bad-mcp', known('.'))],
      }),
      invocationDir,
    );

    expect(result.instructions.appendSystemPromptText).toBeNull();
    expect(result.instructions.failures).toHaveLength(1);
    expectContractRejection(result.instructions.failures[0]!.reason, '..', '解析后未落在供给根之内');
    expect(result.mcp.mcpConfigPath).toBeNull();
    expect(result.mcp.failures).toHaveLength(1);
    expectContractRejection(result.mcp.failures[0]!.reason, '.', '解析后未落在供给根之内');
  });
});

describe('[Story 3.4] 可移植性：同一条修订 + 两个不同的根', () => {
  test('AC1 同一条带相对 sourceRef 的修订在两个根下分别解析到各自根下的真实内容', async () => {
    // 两台各自独立的「机器」，各自在自己的绝对位置上复现了同样的第三方字节
    // （AD-22）。修订本身在两边逐字节相同——不同的只有根。
    const otherRoot = mkdtempSync(path.join(os.tmpdir(), 'control-plane-claude-materializer-src2-'));
    const otherInvocationDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-claude-materializer-inv2-'));
    try {
      writeRealSkillDir('openspec-explore', { 'SKILL.md': 'machine A bytes' }, sourceDir);
      writeRealFile('general.md', 'machine A prompt', sourceDir);
      writeRealSkillDir('openspec-explore', { 'SKILL.md': 'machine B bytes' }, otherRoot);
      writeRealFile('general.md', 'machine B prompt', otherRoot);

      const revision = revisionWith({
        instructions: [ref('instruction', 'general.md', known('general.md'))],
        skills: [ref('skill', 'openspec-explore', known('skills/openspec-explore'))],
      });

      const onA = await materializeClaudeContent(revision, invocationDir);
      process.env.CONTROL_PLANE_SUPPLY_ROOT = otherRoot;
      const onB = await materializeClaudeContent(revision, otherInvocationDir);

      expect(onA.instructions.failures).toEqual([]);
      expect(onB.instructions.failures).toEqual([]);
      expect(onA.instructions.appendSystemPromptText).toBe('machine A prompt');
      expect(onB.instructions.appendSystemPromptText).toBe('machine B prompt');
      expect(readFileSync(path.join(onA.skills.pluginDirPath!, 'skills', 'openspec-explore', 'SKILL.md'), 'utf8')).toBe('machine A bytes');
      expect(readFileSync(path.join(onB.skills.pluginDirPath!, 'skills', 'openspec-explore', 'SKILL.md'), 'utf8')).toBe('machine B bytes');
    } finally {
      // 环境变量覆盖由 `afterEach` 自己恢复；这里多出来的两个目录是本测试自备的。
      rmSync(otherRoot, { recursive: true, force: true });
      rmSync(otherInvocationDir, { recursive: true, force: true });
    }
  });

  test('AC3 一次调用期间根被改动，本次调用的全部引用仍解析于同一个根', async () => {
    const otherRoot = mkdtempSync(path.join(os.tmpdir(), 'control-plane-claude-materializer-src3-'));
    try {
      // `[Story 3.4 patch]` 刻意在*同一组*里放两个引用：每组只有一个引用时这条
      // 测试根本不可能失败，因为 `materializeClaudeContent` 在第一个 `await` 之前
      // 就同步读完了根——「每个引用各自重读 env」的变异体照样全绿。放两个，第二个
      // 才会在第一个已经进入真实 I/O 之后才被解析。
      writeRealSkillDir('one', { 'SKILL.md': 'A-one' }, sourceDir);
      writeRealSkillDir('two', { 'SKILL.md': 'A-two' }, sourceDir);
      writeRealSkillDir('one', { 'SKILL.md': 'B-one' }, otherRoot);
      writeRealSkillDir('two', { 'SKILL.md': 'B-two' }, otherRoot);

      const inFlight = materializeClaudeContent(
        revisionWith({
          skills: [ref('skill', 'one', known('skills/one')), ref('skill', 'two', known('skills/two'))],
        }),
        invocationDir,
      );
      // 微任务先于任何 I/O 完成回调排空，所以这次翻转严格落在「第一个引用开始拷贝」
      // 与「第二个引用被解析」之间：变异体在这里读到 `B-two`，而正确实现（根只快照
      // 一次并向下传）读到的仍是 `A-two`。
      queueMicrotask(() => {
        process.env.CONTROL_PLANE_SUPPLY_ROOT = otherRoot;
      });
      const result = await inFlight;

      expect(result.skills.failures).toEqual([]);
      const pluginDir = result.skills.pluginDirPath!;
      expect(readFileSync(path.join(pluginDir, 'skills', 'one', 'SKILL.md'), 'utf8')).toBe('A-one');
      expect(readFileSync(path.join(pluginDir, 'skills', 'two', 'SKILL.md'), 'utf8')).toBe('A-two');
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});

function revisionWith(overrides: {
  instructions?: CapabilityReference[];
  skills?: CapabilityReference[];
  mcp?: CapabilityReference[];
}) {
  return {
    configName: 'general',
    revisionId: 'rev-1',
    defaultMarker: known(false),
    scopeBoundary: known('scope'),
    availability: known('resolved' as const),
    instructions: overrides.instructions ?? [],
    skills: overrides.skills ?? [],
    mcp: overrides.mcp ?? [],
    hooks: [],
    plugins: [],
    triggerCategory: 'new-scenario' as const,
    evidenceRef: 'test',
    supersedesRevisionId: null,
  };
}
