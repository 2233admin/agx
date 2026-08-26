/**
 * `[Story 3.4]` 冻结区 I/O & Edge-Case Matrix 的最后三行：供给根本身。
 *
 * 环境变量纪律：`CONTROL_PLANE_SUPPLY_ROOT`（以及默认值派生那一行用到的
 * `CONTROL_PLANE_DB_PATH`）都是**保存并恢复**，不是只 `delete`——自我开发本仓
 * 的人完全可能正当地导出了其中任何一个，本文件不得把它抹掉给下一个测试文件用。
 * `tests/adapters/claude-content-materializer.test.ts` 保持同一纪律。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import os from 'node:os';
import path from 'node:path';

import { defaultDbPath } from '../../src/cli/db-path';
import { defaultSupplyRoot, validateSupplyRelativeRef } from '../../src/cli/supply-root';

let originalSupplyRoot: string | undefined;
let originalDbPath: string | undefined;

beforeEach(() => {
  originalSupplyRoot = process.env.CONTROL_PLANE_SUPPLY_ROOT;
  originalDbPath = process.env.CONTROL_PLANE_DB_PATH;
});

afterEach(() => {
  if (originalSupplyRoot === undefined) {
    delete process.env.CONTROL_PLANE_SUPPLY_ROOT;
  } else {
    process.env.CONTROL_PLANE_SUPPLY_ROOT = originalSupplyRoot;
  }
  if (originalDbPath === undefined) {
    delete process.env.CONTROL_PLANE_DB_PATH;
  } else {
    process.env.CONTROL_PLANE_DB_PATH = originalDbPath;
  }
});

describe('defaultSupplyRoot', () => {
  test('CONTROL_PLANE_SUPPLY_ROOT 覆盖：根取该值', () => {
    const overrideRoot = path.join(os.tmpdir(), 'control-plane-supply-root-override', 'lib');
    process.env.CONTROL_PLANE_SUPPLY_ROOT = overrideRoot;
    expect(defaultSupplyRoot()).toBe(overrideRoot);
  });

  test('CONTROL_PLANE_SUPPLY_ROOT 为空串：视为未设置，回落默认根', () => {
    process.env.CONTROL_PLANE_SUPPLY_ROOT = '';
    expect(defaultSupplyRoot()).toBe(path.resolve(path.dirname(defaultDbPath()), 'supply'));
    expect(defaultSupplyRoot()).not.toBe('');
  });

  test('未设 CONTROL_PLANE_SUPPLY_ROOT：默认 path.join(path.dirname(defaultDbPath()), "supply")', () => {
    delete process.env.CONTROL_PLANE_SUPPLY_ROOT;
    expect(defaultSupplyRoot()).toBe(path.resolve(path.dirname(defaultDbPath()), 'supply'));
  });

  test('默认根跟着 defaultDbPath 的状态目录走（发行版用户场景），不是某个仓库派生的路径', () => {
    delete process.env.CONTROL_PLANE_SUPPLY_ROOT;
    const stateDir = path.join(os.tmpdir(), 'control-plane-supply-root-state');
    process.env.CONTROL_PLANE_DB_PATH = path.join(stateDir, 'control-plane.sqlite3');
    expect(defaultSupplyRoot()).toBe(path.join(stateDir, 'supply'));
  });

  test('两侧共用同一个根：连续调用返回同一个值（没有任何一侧的单独覆盖入口）', () => {
    const overrideRoot = path.join(os.tmpdir(), 'control-plane-supply-root-shared');
    process.env.CONTROL_PLANE_SUPPLY_ROOT = overrideRoot;
    expect(defaultSupplyRoot()).toBe(defaultSupplyRoot());
    expect(defaultSupplyRoot()).toBe(overrideRoot);
  });

  /**
   * `[Story 3.4 patch]` 根本身必须是绝对路径。相对的根会把每一条 `sourceRef`
   * 悄悄改指到当前工作目录上，恰好摧毁本 Story 要建立的可移植性保证：同一条修订
   * 在同一台机器上从两个目录启动，会读到两个不同的库。
   */
  test('相对的 CONTROL_PLANE_SUPPLY_ROOT 被规范化为绝对路径，不让解析悬在 cwd 上', () => {
    process.env.CONTROL_PLANE_SUPPLY_ROOT = './lib';
    const root = defaultSupplyRoot();
    expect(path.isAbsolute(root)).toBe(true);
    expect(root).toBe(path.resolve('./lib'));
  });

  test('CONTROL_PLANE_SUPPLY_ROOT 只有空白字符：视为未设置，回落默认根', () => {
    process.env.CONTROL_PLANE_SUPPLY_ROOT = '   ';
    expect(defaultSupplyRoot()).toBe(path.resolve(path.dirname(defaultDbPath()), 'supply'));
  });

  test('CONTROL_PLANE_SUPPLY_ROOT 两端带空白：trim 后采用', () => {
    const overrideRoot = path.join(os.tmpdir(), 'control-plane-supply-root-trim');
    process.env.CONTROL_PLANE_SUPPLY_ROOT = `  ${overrideRoot}  `;
    expect(defaultSupplyRoot()).toBe(path.resolve(overrideRoot));
  });

  test('默认分支同样绝对化：CONTROL_PLANE_DB_PATH 为裸文件名时 path.dirname 是 `.`，根不得变成 cwd 相对的 supply', () => {
    delete process.env.CONTROL_PLANE_SUPPLY_ROOT;
    process.env.CONTROL_PLANE_DB_PATH = 'db.sqlite3';
    const root = defaultSupplyRoot();
    expect(path.isAbsolute(root)).toBe(true);
    expect(root).toBe(path.resolve('supply'));
  });
});

/**
 * `[Story 3.4 patch]` 判定规则只活在这里，在一个导出的谓词里，因此解析侧、
 * 产出侧以及它们的测试在构造上就一致。这几个用例钉住的是两条最容易写错的规则；
 * 完整矩阵在 `tests/adapters/claude-content-materializer.test.ts` 里端到端跑。
 */
describe('validateSupplyRelativeRef', () => {
  const root = path.resolve(path.join(os.tmpdir(), 'control-plane-supply-root-predicate'));

  test('根内以点开头的合法目录名不被误拒（`..x`、`...notes`）', () => {
    expect(validateSupplyRelativeRef('..x', root).ok).toBe(true);
    expect(validateSupplyRelativeRef('...notes', root).ok).toBe(true);
    expect(validateSupplyRelativeRef('skills/..x/SKILL.md', root).ok).toBe(true);
  });

  test('真正的逃逸仍被拒（`..`、`../x`、`a/../../b`）', () => {
    for (const value of ['..', '../x', 'a/../../b']) {
      const verdict = validateSupplyRelativeRef(value, root);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.why).toBe('解析后未落在供给根之内');
    }
  });

  test('盘符前缀在两个平台上都被拒，且理由一致', () => {
    for (const value of ['C:/x/y', 'C:x/y', 'z:foo']) {
      const verdict = validateSupplyRelativeRef(value, root);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.why).toBe('带盘符前缀');
    }
  });

  test('合法值返回规范化后的 ref 与绝对 path', () => {
    const verdict = validateSupplyRelativeRef('./skills/a/../a', root);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.ref).toBe('skills/a');
      expect(verdict.path).toBe(path.join(root, 'skills', 'a'));
    }
  });
});
