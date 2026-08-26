import path from 'node:path';

import { defaultDbPath } from './db-path';

/**
 * `[Story 3.4]` 全仓唯一的供给库根：每一条 `CapabilityReference.sourceRef`
 * 都对它解析（AD-22 显式留下的歧义，现已裁定）——`sourceRef` **只有一种合法
 * 形态，即库内相对 POSIX 路径**，绝不是绝对路径。路径中随机器变化的那一半
 * 只活在这里（本机配置），永不进入 `stable_config_revision`；正因为如此，
 * 同一条修订才能在各自以不同绝对位置复现第三方 Skill 字节的机器之间通用
 * （AD-22）。
 *
 * 这个函数刻意只有一个，解析侧（今天）与供给侧（Story 3.5）共用，不提供任何
 * 一侧的单独覆盖入口——「两个实现者各自发明一个根」正是 AD-22 判为 *critical*
 * 的那个失败。
 *
 * 根有两种部署场景，都是真实存在的，都由这一个函数服务：
 *
 * | Scenario                   | Where the supply library is                      | How the root is obtained                     |
 * | -------------------------- | ------------------------------------------------ | -------------------------------------------- |
 * | 本仓自我开发               | 就是本仓库（`plugins/`、canonical `_bmad/`）     | `CONTROL_PLANE_SUPPLY_ROOT` 指向仓库根       |
 * | 发行版 `configs` 用户      | 那台机器上根本没有「本仓库」这个东西             | 下面的默认值                                 |
 *
 * 默认值只服务第二种场景。它刻意**不**从仓库根派生：编译后的二进制没有仓库可
 * 派生，绕一圈仍要回退到某个 `$HOME` 约定，那不如直接用这个约定——也就是本包
 * 其余持久状态已经落在的同一个 `$HOME/.agent-system-state/control-plane/` 根
 * （见 `db-path.ts`）。
 *
 * `[Story 3.4 patch]` 返回值恒为**绝对路径**，且只含空白字符的覆盖值视同未设置。
 * 这两点都直接关系到本 Story 要建立的可移植性保证：一个相对的根
 * （`CONTROL_PLANE_SUPPLY_ROOT=./lib`，或 `CONTROL_PLANE_DB_PATH=db.sqlite3`
 * 这种裸文件名——它的 `path.dirname` 是 `.`）会让所有 `sourceRef` 悄悄挂在**当前
 * 工作目录**上，于是同一条修订在同一台机器上从两个目录启动就会读到两个库。
 */
export function defaultSupplyRoot(): string {
  const override = process.env.CONTROL_PLANE_SUPPLY_ROOT;
  if (override !== undefined && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.resolve(path.dirname(defaultDbPath()), 'supply');
}

/**
 * `[Story 3.4 patch]` 一条 `sourceRef` 不是合法供给库引用的原因。每个取值就是
 * 用户可见失败文本里出现的原话，因此测试（以及读到启动失败的人）能分辨究竟是
 * *哪一条*规则触发的。
 */
export type SupplyRefRejection =
  | '为空'
  | '含反斜杠'
  | '带盘符前缀'
  | '是绝对路径'
  | '解析后未落在供给根之内';

export type SupplyRefVerdict =
  /** `path` 是绝对位置；`ref` 是同一个位置的规范化（normalized）库内相对 POSIX 形态。 */
  | { readonly ok: true; readonly path: string; readonly ref: string }
  | { readonly ok: false; readonly why: SupplyRefRejection };

/** `path.relative()` 结果的 POSIX 分隔符形态——`sourceRef` 允许出现的唯一分隔符。 */
function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

/**
 * `[Story 3.4]` 「这条 `sourceRef` 合不合法、指向哪里」的**唯一**定义。刻意做成
 * 一个导出的谓词而不是每一侧各存一份：两份手抄副本各自漂移，正是 AD-22 判为
 * critical 的「各自发明」。解析侧
 * （`adapters/clients/claude/content-materializer.ts`）、产出侧
 * （`adapters/sources/cap-fs.ts`，以及 Story 3.5 的供给命令）以及它们的测试
 * 全部调用这里，产出侧因此可以当场自检，而不是产出一个很久以后才被拒的形态。
 *
 * 判定规则，按求值顺序；任一不满足即非法：
 *   1. 非空；
 *   2. 不含反斜杠——POSIX 路径永远不含；win32 上一个反斜杠会「碰巧能用」，而
 *      POSIX 上整串会塌成单个文件名，于是同一条修订在两台机器上含义不同；
 *   3. 不带 `X:` 盘符前缀——理由与 (2) 相同；并且必须放在 (4)/(5) **之前**检查，
 *      因为两个平台在这里分歧了两次：`C:/x/y` 在 win32 上是绝对路径，在 POSIX
 *      上却是个普通相对名；`C:x/y` 在 win32 上是盘符相对（解析到该盘自己的 cwd，
 *      或者当根恰好在同一个盘时被折*进*根内），在 POSIX 上却只是个名叫 `C:x` 的
 *      普通目录。放在这里、并且用模式匹配而不是 `path` 语义来判，才能让判定结果
 *      与诊断信息都与平台无关；
 *   4. `path.isAbsolute()` 为 false；
 *   5. `path.resolve(supplyRoot, value)` 严格落在根**之内**，用 `path.relative`
 *      判：非空（`''` 与 `'.'` 都会解析成根本身——少了这一条，一条这样的引用就会
 *      把*整个*供给库当成一个 Skill `cp` 进去并报告成功，把 AD-10 的 fail-closed
 *      翻成 fail-open）、不等于 `..`、不以 `..<sep>` 开头（只写
 *      `startsWith('..')` 会误拒 `..x` / `...notes` 这类根内的合法名字）、且不是
 *      绝对路径。
 */
export function validateSupplyRelativeRef(value: string, supplyRoot: string): SupplyRefVerdict {
  if (value.length === 0) {
    return { ok: false, why: '为空' };
  }
  if (value.includes('\\')) {
    return { ok: false, why: '含反斜杠' };
  }
  if (/^[A-Za-z]:/.test(value)) {
    return { ok: false, why: '带盘符前缀' };
  }
  if (path.isAbsolute(value)) {
    return { ok: false, why: '是绝对路径' };
  }
  const resolved = path.resolve(supplyRoot, value);
  const relativeToRoot = path.relative(supplyRoot, resolved);
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === '..' ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    return { ok: false, why: '解析后未落在供给根之内' };
  }
  return { ok: true, path: resolved, ref: toPosix(relativeToRoot) };
}

/**
 * `[Story 3.4 patch]` 每一次合同拒绝都会带上、而其他任何东西都不会带上的标记。
 * 下游的 I/O 错误（`ENOENT`、`EISDIR`、JSON 解析失败）不可能包含它，所以断言这个
 * 标记等于在断言「是*合同*拒绝了它」，而不只是「出了点什么错」。
 */
export const SUPPLY_REF_REJECTION_MARKER = 'sourceRef 违反跨机器可移植性合同';

/**
 * 非法 `sourceRef` 唯一的用户可见措辞。它总是同时点名原始值与当时生效的根：
 * 「无门可指根因」正是本 Story 要关闭的问题，所以这份诊断必须一路活到启动失败
 * 的文本里。
 */
export function describeSupplyRefRejection(value: string, supplyRoot: string, why: SupplyRefRejection): string {
  return `${SUPPLY_REF_REJECTION_MARKER}（${why}）：只接受供给库内的相对 POSIX 路径；实际值 \`${value}\`，当前生效的供给根 \`${supplyRoot}\``;
}
