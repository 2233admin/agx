/**
 * `[Story 3.5]` 冻结区 I/O & Edge-Case Matrix + 三条 Acceptance Criteria + 审查
 * 回合（P1–P13）补上的用例。
 *
 * 夹具沿用 `tests/integration/cli-establish.test.ts`：`mkdtemp` 临时目录、
 * `CONTROL_PLANE_DB_PATH` + `CONFIGS_LANG=en`、捕获 `console.log`、用
 * `existsSync(dbPath)` 证明零写入。三处与它不同，都是本 Story 特有的：
 *
 * 1. `console.error` 也要捕获。`configs supply` 的 stdout 是喂给
 *    `configs establish` 的候选 JSON，所以失败块必须走 stderr、stdout 保持为空
 *    ——「零输出」这条断言只有分开捕获两条流才检查得到。
 * 2. `CONTROL_PLANE_SUPPLY_ROOT` 与 `CONTROL_PLANE_DB_PATH` 一样是**保存并恢复**
 *    （同 `tests/cli/supply-root.test.ts` 的纪律），不是只 `delete`：自我开发本仓
 *    的人完全可能正当地导出了它，本文件不得把它抹掉给下一个测试文件用。
 * 3. `[P12]` 「逐字节相同」那条**另起子进程比真实 stdout 字节**。在进程内比
 *    `console.log` 的捕获值是比不出来的：捕获层已经把参数 `String()` 化并 `join`
 *    过，真实的尾随换行与流编码从来没被观察到，一个只在真实写出时才会露出的差异
 *    照样能穿过去。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../../src/cli/index';
import { SqliteConfigRevisionRepository } from '../../src/adapters/sqlite/repository';
import { materializeClaudeContent } from '../../src/adapters/clients/claude/content-materializer';
import { describeSupplyRefRejection, validateSupplyRelativeRef } from '../../src/cli/supply-root';
import { isKnown } from '../../src/domain/facts';

let tmpDir: string;
let libraryRoot: string;
let dbPath: string;
let logs: string[];
let errors: string[];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalSupplyRoot: string | undefined;
let originalDbPath: string | undefined;
let originalLang: string | undefined;

/** 本包根目录——`[P12]` 的子进程要从这里启动 `src/cli/index.ts`。 */
const PACKAGE_ROOT = path.resolve(import.meta.dir, '..', '..');

/**
 * 符号链接的可用性要分两种探测，因为 Windows 对两者的门槛不同：**目录**链接可以
 * 用 junction 建（无需提权，`lstat().isSymbolicLink()` 同样为 true），而**文件**
 * 符号链接要开发者模式或管理员权限，通常直接 `EPERM`。两条各自探测、各自跳过，
 * 免得文件链接的 `EPERM` 把目录链接那几条也一起拖成假绿。
 */
function probeSymlink(type: 'junction' | 'file'): boolean {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'control-plane-symlink-probe-'));
  try {
    if (type === 'junction') {
      mkdirSync(path.join(probe, 'target'));
    } else {
      writeFileSync(path.join(probe, 'target'), 'x');
    }
    // POSIX 上 `type` 参数被忽略，两次探测都建出普通符号链接。
    symlinkSync(path.join(probe, 'target'), path.join(probe, 'link'), type);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const DIR_LINKS_AVAILABLE = probeSymlink('junction');
const FILE_LINKS_AVAILABLE = probeSymlink('file');

/** `<组>/skills/<skill>/` + 一个 `SKILL.md`，外加任意附件——目录约定的最小单位。 */
function writeSkill(root: string, group: string, skill: string, files: Readonly<Record<string, string>>): void {
  const skillDir = path.join(root, group, 'skills', skill);
  mkdirSync(skillDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(skillDir, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'control-plane-cli-supply-'));
  libraryRoot = path.join(tmpDir, 'library');
  dbPath = path.join(tmpDir, 'db.sqlite3');

  originalSupplyRoot = process.env.CONTROL_PLANE_SUPPLY_ROOT;
  originalDbPath = process.env.CONTROL_PLANE_DB_PATH;
  originalLang = process.env.CONFIGS_LANG;
  process.env.CONTROL_PLANE_SUPPLY_ROOT = libraryRoot;
  process.env.CONTROL_PLANE_DB_PATH = dbPath;
  process.env.CONFIGS_LANG = 'en';

  // `alpha` 一套夹具覆盖四件事：
  //  - 排序：`Z-skill` 与 `a-skill` 并存。code unit 序下 'Z'(0x5A) < 'a'(0x61)，
  //    而 `localeCompare` 在多数 locale 下把 `a-skill` 排前面——`[P11]` 要求排序
  //    谓词被真正钉住，所以这两个名字的相对次序本身就是断言内容。
  //  - `readdir` 顺序无关：两者的创建顺序与期望输出顺序相反。
  //  - 缺 `SKILL.md` 的旁支目录不计入。
  //  - `skills/` 之外的组级目录不参与。
  writeSkill(libraryRoot, 'alpha', 'a-skill', { 'SKILL.md': '# a\n', 'refs/notes.md': 'attachment\n' });
  writeSkill(libraryRoot, 'alpha', 'Z-skill', { 'SKILL.md': '# Z\n' });
  mkdirSync(path.join(libraryRoot, 'alpha', 'skills', 'not-a-skill'), { recursive: true });
  writeFileSync(path.join(libraryRoot, 'alpha', 'skills', 'not-a-skill', 'README.md'), 'no SKILL.md here\n');
  mkdirSync(path.join(libraryRoot, 'alpha', 'LICENSES'), { recursive: true });

  writeSkill(libraryRoot, 'beta', 'b-skill', { 'SKILL.md': '# b\n' });
  // `[P10]` 多段组名——本仓自我开发场景（根=仓库根，组=`plugins/<组>`）的形状。
  writeSkill(libraryRoot, 'nested/deep', 'n-skill', { 'SKILL.md': '# n\n' });

  // 组目录存在，但根本没有 `skills/` 子目录。
  mkdirSync(path.join(libraryRoot, 'bare-group'), { recursive: true });
  // 组目录与 `skills/` 都在，里面却没有一个含 `SKILL.md` 的目录。
  mkdirSync(path.join(libraryRoot, 'no-valid-skill', 'skills', 'x'), { recursive: true });
  writeFileSync(path.join(libraryRoot, 'no-valid-skill', 'skills', 'x', 'README.md'), 'still no SKILL.md\n');

  // `[P1]` 两个组含同名 skill，内容不同——物化时会互相覆盖的那一对。
  writeSkill(libraryRoot, 'dup-a', 'dup', { 'SKILL.md': '# dup from a\n' });
  writeSkill(libraryRoot, 'dup-b', 'dup', { 'SKILL.md': '# dup from b\n' });

  // `[P13]` 根**之外**的一个完全合规的组。它是「逃逸引用是被合同拒掉的，
  // 不是被文件系统 404 掉的」这条断言的诱饵：少了逃逸检查，`--group ../outside`
  // 会成功产出它。
  writeSkill(tmpDir, 'outside', 'o-skill', { 'SKILL.md': '# outside\n' });

  logs = [];
  errors = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  };
  restore('CONTROL_PLANE_SUPPLY_ROOT', originalSupplyRoot);
  restore('CONTROL_PLANE_DB_PATH', originalDbPath);
  restore('CONFIGS_LANG', originalLang);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** stdout 的全部内容——`supply` 成功时它就是候选 JSON 本身。 */
function stdout(): string {
  return logs.join('\n');
}

interface CandidateFact {
  readonly kind: string;
  readonly value?: unknown;
  readonly reason?: string;
  readonly observedAt?: string;
}

interface ParsedCandidate {
  readonly configName: string;
  readonly defaultMarker: CandidateFact;
  readonly scopeBoundary: CandidateFact;
  readonly availability: CandidateFact;
  readonly skills: ReadonlyArray<{
    readonly kind: string;
    readonly name: string;
    readonly sourceCategory: CandidateFact;
    readonly summary: CandidateFact;
    readonly sourceRef: CandidateFact & { readonly value?: string };
    readonly contentFingerprint: CandidateFact & { readonly value?: string };
  }>;
}

function parseStdoutCandidate(): ParsedCandidate {
  return JSON.parse(stdout()) as ParsedCandidate;
}

/**
 * `[P12]` 真正的 stdout 字节：另起一个 `bun src/cli/index.ts …` 子进程，直接拿它
 * 的 stdout Buffer。这是唯一能支撑「逐字节相同」的观察方式——尾随换行、编码、
 * 流上真实写出的内容全在里面。
 */
async function supplyStdoutBytes(args: readonly string[], supplyRoot: string = libraryRoot): Promise<Buffer> {
  const child = Bun.spawn([process.execPath, 'src/cli/index.ts', 'supply', ...args], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, CONTROL_PLANE_SUPPLY_ROOT: supplyRoot, CONTROL_PLANE_DB_PATH: dbPath, CONFIGS_LANG: 'en' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [bytes, exitCode] = await Promise.all([child.stdout.bytes(), child.exited]);
  expect(exitCode).toBe(0);
  return Buffer.from(bytes);
}

describe('configs supply -- 成功路径', () => {
  test('单组：规范化 sourceRef、sha256 指纹，以及三个标量 Fact 的诚实取值', async () => {
    writeSkill(libraryRoot, 'solo', 'solo', { 'SKILL.md': '# solo\n' });

    const code = await main(['supply', '--config-name', 'general', '--group', 'solo']);
    expect(code).toBe(0);
    expect(errors).toEqual([]);

    const candidate = parseStdoutCandidate();
    expect(candidate.configName).toBe('general');
    expect(candidate.skills).toHaveLength(1);
    expect(candidate.skills[0]!.kind).toBe('skill');
    expect(candidate.skills[0]!.name).toBe('solo');
    expect(candidate.skills[0]!.sourceCategory).toEqual({ kind: 'known', value: 'project-skill-import' });
    expect(candidate.skills[0]!.summary).toEqual({ kind: 'known', value: 'skill reference: solo' });
    expect(candidate.skills[0]!.sourceRef).toEqual({ kind: 'known', value: 'solo/skills/solo' });
    expect(candidate.skills[0]!.contentFingerprint.kind).toBe('known');
    expect(candidate.skills[0]!.contentFingerprint.value).toMatch(/^sha256:[0-9a-f]{64}$/);

    // `[P11]` 三个标量 Fact 此前无人断言，于是把 `defaultMarker` 改成
    // `known(true)` 也能全绿——一条 AD-8 明令禁止的伪造事实可以一路进库，并在
    // `configs show` 里把这份配置显示成「默认」。钉死它们。
    expect(candidate.defaultMarker).toEqual({
      kind: 'unknown',
      reason: 'not-decided-by-configs-supply',
      observedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(candidate.scopeBoundary).toEqual({ kind: 'known', value: 'configs supply: groups solo' });
    expect(candidate.availability).toEqual({ kind: 'known', value: 'resolved' });

    // 供给是纯读路径：它绝不打开（更不会创建/迁移）SQLite 文件。
    expect(existsSync(dbPath)).toBe(false);
  });

  test('多组：两组条目合并，整份候选与 --group 的书写顺序完全无关（逐字节）', async () => {
    expect(await main(['supply', '--config-name', 'general', '--group', 'beta', '--group', 'alpha'])).toBe(0);
    const betaFirst = stdout();
    logs = [];
    expect(await main(['supply', '--config-name', 'general', '--group', 'alpha', '--group', 'beta'])).toBe(0);
    const alphaFirst = stdout();

    // `[P3]` 此前只断言 `sourceRef` 的顺序，于是 `scopeBoundary` 里那份按用户书写
    // 顺序、未规范化的组名列表随便怎么漂都发现不了。冻结区要求的是「同一库同一组
    // **集合**逐字节相同」——集合，与书写顺序无关，所以整份候选都要比。
    expect(alphaFirst).toBe(betaFirst);
    expect(JSON.parse(alphaFirst).scopeBoundary).toEqual({ kind: 'known', value: 'configs supply: groups alpha, beta' });
    expect((JSON.parse(alphaFirst) as ParsedCandidate).skills.map((skill) => skill.sourceRef.value)).toEqual([
      'alpha/skills/Z-skill',
      'alpha/skills/a-skill',
      'beta/skills/b-skill',
    ]);
  });

  test('排序谓词是 code unit 序，不是 localeCompare', async () => {
    expect(await main(['supply', '--config-name', 'general', '--group', 'alpha'])).toBe(0);

    // `[P11]` `Z-skill` 必须排在 `a-skill` **前面**：code unit 序下 'Z' < 'a'，
    // 而 `localeCompare` 会给出相反的结论。把 `compareCodeUnits` 换成
    // `localeCompare`，这一条会红——此前的夹具全是小写，两种谓词结论一致，
    // 所以那个替换是检测不到的。
    expect(parseStdoutCandidate().skills.map((skill) => skill.name)).toEqual(['Z-skill', 'a-skill']);
  });

  test('缺 SKILL.md 的目录不计入（同组其余 skill 照常产出）', async () => {
    expect(await main(['supply', '--config-name', 'general', '--group', 'alpha'])).toBe(0);
    const names = parseStdoutCandidate().skills.map((skill) => skill.name);
    expect(names).toEqual(['Z-skill', 'a-skill']);
    expect(names).not.toContain('not-a-skill');
  });

  test('多段组名：本仓自我开发场景（根=仓库根、组=多段路径）的形状', async () => {
    expect(await main(['supply', '--config-name', 'general', '--group', 'nested/deep'])).toBe(0);
    expect(parseStdoutCandidate().skills[0]!.sourceRef.value).toBe('nested/deep/skills/n-skill');
  });

  test('确定性：同一库同一组集合连跑两次，真实 stdout 字节相同', async () => {
    const first = await supplyStdoutBytes(['--config-name', 'general', '--group', 'alpha', '--group', 'beta']);
    const second = await supplyStdoutBytes(['--config-name', 'general', '--group', 'beta', '--group', 'alpha']);

    expect(first.byteLength).toBeGreaterThan(0);
    expect(second.equals(first)).toBe(true);
  });
});

describe('configs supply -- fail-closed（AD-10）：零 stdout 输出，退出 1', () => {
  test('组不存在：SupplyGroupNotFoundError，点名组与根，并给出恢复指引', async () => {
    const code = await main(['supply', '--config-name', 'general', '--group', 'nope']);
    expect(code).toBe(1);
    expect(stdout()).toBe('');
    const reported = errors.join('\n');
    expect(reported).toContain('no group "nope"');
    expect(reported).toContain(libraryRoot);
    expect(reported).toContain('Recovery:');
    // `[P8]` 失败块的主体是「supply」，不是那份还不存在的配置。用 --config-name
    // 的值当标签，会渲染出「Configuration "general": … supply library root … does
    // not exist」这种误报主体的句子。
    expect(reported).toContain('Configuration "supply":');
    expect(reported).not.toContain('"general"');
  });

  test('失败标签恒为 supply，与 --config-name 的取值无关', async () => {
    process.env.CONTROL_PLANE_SUPPLY_ROOT = path.join(tmpDir, 'no-such-library');
    expect(await main(['supply', '--config-name', 'a-very-distinctive-config', '--group', 'alpha'])).toBe(1);
    expect(errors.join('\n')).toContain('Configuration "supply":');
    expect(errors.join('\n')).not.toContain('a-very-distinctive-config');
  });

  /**
   * `[P4]` 「不存在」与「读不动」的分界，可移植的那一半：路径中间有一段是普通
   * 文件时 `lstat` 给 `ENOTDIR`，这必须仍然算「没有这个组」。把 `ENOTDIR` 从
   * `isMissingPath` 里拿掉，这一条会变成 unreadable 而红。（另一半——`EACCES`
   * 不得被吞成「不存在」——只有权限位能触发，见下面那条 POSIX-only 用例。）
   */
  test('组路径中间一段是普通文件（ENOTDIR）：仍然算「没有这个组」', async () => {
    writeFileSync(path.join(libraryRoot, 'plain-file'), 'not a directory\n');
    expect(await main(['supply', '--config-name', 'general', '--group', 'plain-file/sub'])).toBe(1);
    expect(stdout()).toBe('');
    const reported = errors.join('\n');
    expect(reported).toContain('no group "plain-file/sub"');
    expect(reported).not.toContain('could not read');
  });

  test('组内无 skill（组目录存在但没有 skills/）：SupplyGroupEmptyError，不是空集', async () => {
    const code = await main(['supply', '--config-name', 'general', '--group', 'bare-group']);
    expect(code).toBe(1);
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain('contains no skill directory with a SKILL.md');
    expect(errors.join('\n')).toContain('Recovery:');
  });

  test('组内 skills/ 存在但没有一个含 SKILL.md：同样是 SupplyGroupEmptyError', async () => {
    const code = await main(['supply', '--config-name', 'general', '--group', 'no-valid-skill']);
    expect(code).toBe(1);
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain('contains no skill directory with a SKILL.md');
  });

  test('一组合规、一组为空：整体失败，绝不产出部分候选', async () => {
    const code = await main(['supply', '--config-name', 'general', '--group', 'alpha', '--group', 'bare-group']);
    expect(code).toBe(1);
    // 「部分候选」正是 AD-10 要禁的东西：alpha 明明扫描成功了，也一个字节都不能吐。
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain('bare-group');
  });

  test('库根不存在：SupplyRootNotFoundError，原因含该根', async () => {
    const missingRoot = path.join(tmpDir, 'no-such-library');
    process.env.CONTROL_PLANE_SUPPLY_ROOT = missingRoot;

    const code = await main(['supply', '--config-name', 'general', '--group', 'alpha']);
    expect(code).toBe(1);
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain(missingRoot);
  });

  test('库根是个文件而不是目录：同样是 SupplyRootNotFoundError', async () => {
    const fileRoot = path.join(tmpDir, 'library-as-file');
    writeFileSync(fileRoot, 'not a directory\n');
    process.env.CONTROL_PLANE_SUPPLY_ROOT = fileRoot;

    expect(await main(['supply', '--config-name', 'general', '--group', 'alpha'])).toBe(1);
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain(fileRoot);
  });

  /**
   * `[P1 critical]` 两个组含同名 skill。这是本轮审查抓到的确认缺陷：解析侧
   * `materializeSkills` 用 `sanitizePathSegment(reference.name)` 推导目标目录，
   * 两条同名引用会先后 `cp` 到同一个 `materialized/plugin/skills/dup`，后者覆盖
   * 前者，`failures` 却是空数组、整次启动报告成功。修在产出侧：拒绝产出这种修订。
   */
  test('两个组含同名 skill：SupplyDuplicateSkillNameError，整体失败', async () => {
    const code = await main(['supply', '--config-name', 'general', '--group', 'dup-a', '--group', 'dup-b']);
    expect(code).toBe(1);
    expect(stdout()).toBe('');
    const reported = errors.join('\n');
    expect(reported).toContain('skill name "dup" is supplied by two different groups');
    expect(reported).toContain('dup-a/skills/dup');
    expect(reported).toContain('dup-b/skills/dup');
  });

  test('同名 skill 只在单个组内出现时不受影响（同名判定是跨组的，不是全局黑名单）', async () => {
    expect(await main(['supply', '--config-name', 'general', '--group', 'dup-a'])).toBe(0);
    expect(parseStdoutCandidate().skills.map((skill) => skill.name)).toEqual(['dup']);
  });

  test.each([
    ['解析后未落在供给根之内', '../outside'],
    ['带盘符前缀', 'C:alpha'],
    ['含反斜杠', 'alpha\\beta'],
  ] as const)('产出自检失败（%s）：typed 拒绝，原因含该值与根', async (why, group) => {
    const code = await main(['supply', '--config-name', 'general', '--group', group]);
    expect(code).toBe(1);
    expect(stdout()).toBe('');
    const reported = errors.join('\n');
    expect(reported).toContain('produced-side self-check failed');
    expect(reported).toContain('violates the cross-machine portability contract');
    expect(reported).toContain(group);
    expect(reported).toContain(libraryRoot);
    // `[P9]` en 模式下不得混排中文——此前的断言直接查一个中文常量
    // (`SUPPLY_REF_REJECTION_MARKER`)，而整套测试跑在 `CONFIGS_LANG=en` 下，
    // 于是「en 输出里混着中文」这个缺陷永远发现不了。
    expect(reported).not.toMatch(/[一-鿿]/);
    // 判定枝真的被区分了，而不是笼统报个「不合法」。
    const enWhy = { 解析后未落在供给根之内: 'resolves outside the supply root', 带盘符前缀: 'has a drive-letter prefix', 含反斜杠: 'contains a backslash' }[why];
    expect(reported).toContain(enWhy);
  });

  /**
   * `[P13]` 此前这里的注释说「逃出根的那一条必须在任何 readdir 之前就被拒——根外
   * 目录一次都没被访问」，断言却是 `existsSync(dbPath) === false`（SQLite 路径，
   * 与有没有读过根外目录毫无关系）。改成真的验它：`<tmpDir>/outside` 是一个**完全
   * 合规**的组，少了逃逸检查，`--group ../outside` 会成功产出 `o-skill`。
   */
  test('逃逸引用是被合同拒掉的，不是被文件系统 404 掉的', async () => {
    // 诱饵确实合规：把它放在根内，同样的组名能正常产出。
    writeSkill(libraryRoot, 'inside-copy', 'o-skill', { 'SKILL.md': '# outside\n' });
    expect(await main(['supply', '--config-name', 'general', '--group', 'inside-copy'])).toBe(0);
    expect(parseStdoutCandidate().skills[0]!.name).toBe('o-skill');

    logs = [];
    errors = [];
    expect(await main(['supply', '--config-name', 'general', '--group', '../outside'])).toBe(1);
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain('resolves outside the supply root');
    expect(errors.join('\n')).not.toContain('o-skill');
  });

  test.skipIf(!FILE_LINKS_AVAILABLE)('SKILL.md 是符号链接：硬拒绝，而不是过门后算出空输入的 sha256', async () => {
    const skillDir = path.join(libraryRoot, 'linky', 'skills', 'linky');
    mkdirSync(skillDir, { recursive: true });
    const realTarget = path.join(tmpDir, 'real-skill-md');
    writeFileSync(realTarget, '# linky\n');
    symlinkSync(realTarget, path.join(skillDir, 'SKILL.md'));

    const code = await main(['supply', '--config-name', 'general', '--group', 'linky']);
    expect(code).toBe(1);
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain('symbolic link');
    expect(errors.join('\n')).toContain('cannot be fingerprinted reproducibly');
  });

  test.skipIf(!DIR_LINKS_AVAILABLE)('skill 目录内的链接目录附件：同样硬拒绝（遍历阶段）', async () => {
    writeSkill(libraryRoot, 'linky2', 'linky2', { 'SKILL.md': '# linky2\n' });
    const realTarget = path.join(tmpDir, 'real-attachment-dir');
    mkdirSync(realTarget, { recursive: true });
    writeFileSync(path.join(realTarget, 'notes.md'), 'attachment\n');
    symlinkSync(realTarget, path.join(libraryRoot, 'linky2', 'skills', 'linky2', 'refs'), 'junction');

    expect(await main(['supply', '--config-name', 'general', '--group', 'linky2'])).toBe(1);
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain('symbolic link');
    expect(errors.join('\n')).toContain('cannot be fingerprinted reproducibly');
  });

  test.skipIf(!DIR_LINKS_AVAILABLE)('skill 目录本身是链接：硬拒绝，而不是静默少一个 skill', async () => {
    writeSkill(libraryRoot, 'linky3', 'real', { 'SKILL.md': '# real\n' });
    symlinkSync(
      path.join(libraryRoot, 'linky3', 'skills', 'real'),
      path.join(libraryRoot, 'linky3', 'skills', 'aliased'),
      'junction',
    );

    // 静默跳过会让这个组只产出 `real`、看起来一切正常——正是「看起来完整、实则
    // 少了内容」。必须整体失败。
    expect(await main(['supply', '--config-name', 'general', '--group', 'linky3'])).toBe(1);
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain('symbolic link');
  });

  /**
   * `[P5]` I/O 失败必须是**典型化**拒绝（退出 1，走 `renderQueryFailure`），不能
   * 冒成 rejected promise：直接调 `main()` 的调用方拿到的会是异常而不是退出码。
   *
   * 触发方式只能靠权限位，因此 Windows 上跳过（`chmod` 在那里是 no-op）。
   * 这是本文件唯一一条平台受限的用例，也是这个错误类目前唯一的端到端覆盖。
   */
  test.skipIf(process.platform === 'win32')('组目录读不动（EACCES）：typed unreadable，而不是「没有这个组」', async () => {
    const { chmodSync } = await import('node:fs');
    const groupDir = path.join(libraryRoot, 'locked');
    writeSkill(libraryRoot, 'locked', 'locked', { 'SKILL.md': '# locked\n' });
    chmodSync(path.join(groupDir, 'skills'), 0o000);
    try {
      const code = await main(['supply', '--config-name', 'general', '--group', 'locked']);
      expect(code).toBe(1);
      expect(stdout()).toBe('');
      const reported = errors.join('\n');
      expect(reported).toContain('could not read');
      expect(reported).toContain('locked');
      // 关键：不得被误报成「根下没有这个组」。
      expect(reported).not.toContain('no group');
    } finally {
      chmodSync(path.join(groupDir, 'skills'), 0o755);
    }
  });

  test('zh 模式下，产出侧的拒绝文案与解析侧 describeSupplyRefRejection 逐字相同', async () => {
    process.env.CONFIGS_LANG = 'zh';
    expect(await main(['supply', '--config-name', 'general', '--group', 'C:alpha'])).toBe(1);
    // `[P9]` 本地化不能把「产出侧与解析侧对同一条引用说同一句话」这条性质弄丢：
    // zh 侧必须仍然逐字等于解析侧那句。这条断言就是防两处措辞漂移的锁。
    expect(errors.join('\n')).toContain(describeSupplyRefRejection('C:alpha', libraryRoot, '带盘符前缀'));
  });
});

describe('configs supply -- usage error（退出 2）', () => {
  test('缺 --group：用法错误 + usage 行', async () => {
    const code = await main(['supply', '--config-name', 'general']);
    expect(code).toBe(2);
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain('at least one --group');
    expect(errors.join('\n')).toContain('usage:');
  });

  test('缺 --config-name：用法错误 + usage 行', async () => {
    const code = await main(['supply', '--group', 'alpha']);
    expect(code).toBe(2);
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain('missing --config-name');
    expect(errors.join('\n')).toContain('usage:');
  });

  test('重复同名 --group：用法错误（不静默去重）', async () => {
    const code = await main(['supply', '--config-name', 'general', '--group', 'alpha', '--group', 'alpha']);
    expect(code).toBe(2);
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain('was declared more than once');
    expect(errors.join('\n')).toContain('usage:');
  });

  /**
   * `[P2]` 判定必须跑在**规范化之后**。此前比的是原始 argv 串，于是同一个组的两
   * 种写法能穿过去，整批 skill 被产出两遍（随后又会撞上 `[P1]` 的同名检出，
   * 但那是另一条规则，掩盖不了这条的漏判）。
   */
  test.each([['./alpha'], ['alpha/'], ['alpha/./']])('同一个组的另一种写法（%s）同样判为重复', async (spelling) => {
    const code = await main(['supply', '--config-name', 'general', '--group', 'alpha', '--group', spelling]);
    expect(code).toBe(2);
    expect(stdout()).toBe('');
    expect(errors.join('\n')).toContain('was declared more than once');
  });

  test('--group 空值：与 --config-name 空值同为 usage error（退出 2），不是运行期拒绝', async () => {
    // `[P7]` 此前 `--group ''` 会穿过 parse、到运行时才以「产出自检失败」退出 1
    // ——同一类用户错误两个退出码。
    expect(await main(['supply', '--config-name', 'general', '--group', ''])).toBe(2);
    expect(errors.join('\n')).toContain('--group requires a non-empty value');

    errors = [];
    expect(await main(['supply', '--config-name', 'general', '--group', '   '])).toBe(2);
    expect(errors.join('\n')).toContain('--group requires a non-empty value');

    errors = [];
    expect(await main(['supply', '--config-name', '  ', '--group', 'alpha'])).toBe(2);
    expect(errors.join('\n')).toContain('missing --config-name');
  });

  test('--group 前后空白被 trim（`" alpha "` 与 `alpha` 是同一个组）', async () => {
    expect(await main(['supply', '--config-name', 'general', '--group', ' alpha ', '--group', 'alpha'])).toBe(2);
    expect(errors.join('\n')).toContain('was declared more than once');
  });

  test('--config-name 传两次 / 缺值：复用 establish 既有的 flag 文案 key', async () => {
    expect(await main(['supply', '--config-name', 'a', '--config-name', 'b', '--group', 'alpha'])).toBe(2);
    expect(errors.join('\n')).toContain('--config-name can only be passed once');

    errors = [];
    expect(await main(['supply', '--config-name'])).toBe(2);
    expect(errors.join('\n')).toContain('--config-name requires a value');

    errors = [];
    expect(await main(['supply', '--config-name', 'general', '--group'])).toBe(2);
    expect(errors.join('\n')).toContain('--group requires a value');
  });

  test('未知 flag：用法错误', async () => {
    // `--library` 是刻意*不*提供的那个 flag（Design Notes：供给侧若能单独指定库
    // 路径，就能产出一条解析侧按另一个根去找的修订）。它落在通用未知 flag 分支。
    expect(await main(['supply', '--config-name', 'general', '--group', 'alpha', '--library', '/tmp/other'])).toBe(2);
    expect(errors.join('\n')).toContain('unknown flag: --library');
  });
});

describe('configs supply -- 指纹语义', () => {
  test('只改附件内容：sourceRef 不变，contentFingerprint 变', async () => {
    expect(await main(['supply', '--config-name', 'general', '--group', 'alpha'])).toBe(0);
    const before = parseStdoutCandidate().skills.find((skill) => skill.name === 'a-skill')!;

    writeFileSync(path.join(libraryRoot, 'alpha', 'skills', 'a-skill', 'refs', 'notes.md'), 'attachment, edited\n');

    logs = [];
    expect(await main(['supply', '--config-name', 'general', '--group', 'alpha'])).toBe(0);
    const after = parseStdoutCandidate().skills.find((skill) => skill.name === 'a-skill')!;

    expect(after.sourceRef.value).toBe(before.sourceRef.value);
    expect(after.contentFingerprint.value).not.toBe(before.contentFingerprint.value);
  });

  /**
   * `[P11]` 指纹的**构成**此前完全没被钉住：把 `hash.update(relativePath)` 与两处
   * 分隔符去掉、只喂内容，21 条用例照样全绿。下面两条各钉一半。
   */
  test('内容不变、只改文件名：contentFingerprint 必须变（路径参与摘要）', async () => {
    writeSkill(libraryRoot, 'renamed', 'renamed', { 'SKILL.md': '# r\n', 'a.md': 'same bytes\n' });
    expect(await main(['supply', '--config-name', 'general', '--group', 'renamed'])).toBe(0);
    const before = parseStdoutCandidate().skills[0]!;

    rmSync(path.join(libraryRoot, 'renamed', 'skills', 'renamed', 'a.md'));
    writeFileSync(path.join(libraryRoot, 'renamed', 'skills', 'renamed', 'b.md'), 'same bytes\n');

    logs = [];
    expect(await main(['supply', '--config-name', 'general', '--group', 'renamed'])).toBe(0);
    const after = parseStdoutCandidate().skills[0]!;

    expect(after.sourceRef.value).toBe(before.sourceRef.value);
    expect(after.contentFingerprint.value).not.toBe(before.contentFingerprint.value);
  });

  test('长度前缀是单射的：路径/内容的边界移动会改变指纹', async () => {
    // 拼接编码（无长度前缀、无分隔符）下这两棵树喂进哈希的字节流完全相同：
    //   "ab" + "c"   vs   "a" + "bc"
    // 长度前缀让它们必然不同。这一条直接钉住 `uint64BE` 前缀的存在。
    writeSkill(libraryRoot, 'inj-1', 's', { 'SKILL.md': '', ab: 'c' });
    writeSkill(libraryRoot, 'inj-2', 's', { 'SKILL.md': '', a: 'bc' });

    expect(await main(['supply', '--config-name', 'general', '--group', 'inj-1'])).toBe(0);
    const one = parseStdoutCandidate().skills[0]!.contentFingerprint.value;
    logs = [];
    expect(await main(['supply', '--config-name', 'general', '--group', 'inj-2'])).toBe(0);
    const two = parseStdoutCandidate().skills[0]!.contentFingerprint.value;

    expect(one).not.toBe(two);
  });
});

describe('configs supply -- Acceptance Criteria', () => {
  test('AC1：产出可被 configs establish 直接消费，configs show 显示各条来源引用与指纹', async () => {
    expect(await main(['supply', '--config-name', 'general', '--group', 'alpha', '--group', 'beta'])).toBe(0);
    const candidatePath = path.join(tmpDir, 'candidate.json');
    writeFileSync(candidatePath, stdout());
    const expectedFingerprint = parseStdoutCandidate().skills[0]!.contentFingerprint.value!;

    logs = [];
    expect(
      await main(['establish', '--trigger-category', 'new-scenario', '--evidence', 'story-3-5-supply', '--from', candidatePath]),
    ).toBe(0);

    const repository = new SqliteConfigRevisionRepository(dbPath);
    let revisionId: string;
    try {
      const all = await repository.listAll();
      expect(all).toHaveLength(1);
      expect(all[0]!.skills).toHaveLength(3);
      revisionId = all[0]!.revisionId;
    } finally {
      repository.close();
    }

    logs = [];
    expect(await main(['show', revisionId])).toBe(0);
    const shown = stdout();
    expect(shown).toContain('alpha/skills/a-skill');
    expect(shown).toContain('alpha/skills/Z-skill');
    expect(shown).toContain('beta/skills/b-skill');
    expect(shown).toContain(expectedFingerprint);
  });

  test('AC2：落库后的每条 sourceRef 都被解析侧物化成功，无 unsupported/degraded', async () => {
    expect(await main(['supply', '--config-name', 'general', '--group', 'alpha', '--group', 'beta'])).toBe(0);
    const candidatePath = path.join(tmpDir, 'candidate.json');
    writeFileSync(candidatePath, stdout());
    logs = [];
    expect(
      await main(['establish', '--trigger-category', 'new-scenario', '--evidence', 'story-3-5-materialize', '--from', candidatePath]),
    ).toBe(0);

    const repository = new SqliteConfigRevisionRepository(dbPath);
    let revision;
    try {
      revision = (await repository.listAll())[0]!;
    } finally {
      repository.close();
    }

    // 解析侧从 `defaultSupplyRoot()` 自己取根（本测试里就是 `libraryRoot`）——
    // 产出侧与解析侧共用同一套判定、同一个根，这正是本条 AC 要证的东西。
    const invocationDir = path.join(tmpDir, 'invocation');
    mkdirSync(invocationDir, { recursive: true });
    const result = await materializeClaudeContent(revision, invocationDir);

    expect(result.skills.failures).toEqual([]);
    expect(result.skills.pluginDirPath).not.toBeNull();
    for (const skill of revision.skills) {
      expect(isKnown(skill.sourceRef)).toBe(true);
      expect(existsSync(path.join(result.skills.pluginDirPath!, 'skills', skill.name, 'SKILL.md'))).toBe(true);
      // 同一条 `sourceRef` 在解析侧被判合法，并解析到真实目录——不是「碰巧也能读」。
      const verdict = validateSupplyRelativeRef((skill.sourceRef as { value: string }).value, libraryRoot);
      expect(verdict.ok).toBe(true);
    }
    // 附件（不只 SKILL.md）也一起物化了，与指纹的覆盖面一致。
    expect(existsSync(path.join(result.skills.pluginDirPath!, 'skills', 'a-skill', 'refs', 'notes.md'))).toBe(true);
  });

  test('AC3：同一组在两个不同库根下内容不同 -> sourceRef 相同、contentFingerprint 不同', async () => {
    const otherRoot = path.join(tmpDir, 'other-library');
    writeSkill(otherRoot, 'beta', 'b-skill', { 'SKILL.md': '# b, but different bytes\n' });

    expect(await main(['supply', '--config-name', 'general', '--group', 'beta'])).toBe(0);
    const fromFirstRoot = parseStdoutCandidate().skills[0]!;

    logs = [];
    process.env.CONTROL_PLANE_SUPPLY_ROOT = otherRoot;
    expect(await main(['supply', '--config-name', 'general', '--group', 'beta'])).toBe(0);
    const fromSecondRoot = parseStdoutCandidate().skills[0]!;

    // 指纹绑的是内容，不是路径：根变了、位置形态没变，只有指纹变。
    expect(fromSecondRoot.sourceRef.value).toBe(fromFirstRoot.sourceRef.value);
    expect(fromSecondRoot.contentFingerprint.value).not.toBe(fromFirstRoot.contentFingerprint.value);
  });
});
