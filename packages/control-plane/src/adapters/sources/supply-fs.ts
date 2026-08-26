/**
 * `[Story 3.5]` 供给库的只读扫描器：把「显式声明的一批**组**」变成一批
 * `CapabilityReference`，供 `configs supply` 打成候选 JSON、再由既有
 * `configs establish` 消费。它不写任何东西，也不认识 SQLite。
 *
 * **供给库组织即目录约定**：`<supplyRoot>/<组>/skills/<skill>/`，每个 skill
 * 目录须含 `SKILL.md`。组是装配与判定的单元（AD-22），目录结构**就是**组定义
 * ——没有第二处 manifest 可以与它漂移。
 *
 * `[P10]` 组名**可以是多段路径**，这不是附带效果而是本仓自我开发场景所必需的。
 * `supply-root.ts` 的部署场景表规定：自我开发本仓时 `CONTROL_PLANE_SUPPLY_ROOT`
 * 指向**仓库根**，不是 `plugins/`。于是本仓的组要写成 `--group plugins/grilling`，
 * 产出 `sourceRef: plugins/grilling/skills/grilling`——恰好就是 `cap-fs.ts` 对同
 * 一批 Skill 产出的仓库根相对形式，两条产出路径因此自洽。（只有当根恰好取
 * `plugins/` 时，组才退化成单段的 `grilling`。）
 *
 * 三条不可让步的性质，理由都写在这里，而不是散落在调用点：
 *
 * 1. **根只作参数传入**，本模块自己既不调 `defaultSupplyRoot()` 也不读
 *    `CONTROL_PLANE_SUPPLY_ROOT`——形制先例是 `cap-fs.ts` 的
 *    `loadCapConfigRevisions(capRoot)`。一次 CLI 调用只快照一次根，供给侧与
 *    解析侧因此不可能各自解析出两个根（AD-22 判为 *critical* 的那个失败）。
 * 2. **产出即自检**：每条 `sourceRef` 都经解析侧用的同一个
 *    `validateSupplyRelativeRef` 校验，并**采用它返回的规范化 `ref`**，而不是
 *    自己拼的那个字符串——同一引用因此只有一种编码。产出侧绝不吐出一个稍后必被
 *    读侧 fail-closed 拒掉的形态。次序照抄 `cap-fs.ts` 的 `capSupplyRef`：
 *    先校验，再用校验结果。
 * 3. **fail-closed（AD-10）**：任一被声明的组解析不出内容，整个调用抛错，
 *    调用方零输出、非零退出。绝不返回「部分候选」——一份少了几个 Skill 的装配
 *    与一份完整装配长得一模一样，正是这类静默降级要杜绝的。同理，**没有一处
 *    `catch` 把 I/O 失败吞成「没有这个东西」**：`EACCES` 与 `ENOENT` 在一个以
 *    fail-closed 为前提的命令里含义天差地别。
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

import { known, unknown } from '../../domain/facts';
import type { Fact } from '../../domain/facts';
import type { CapabilityReference, SourceCategory } from '../../domain/config';
import { validateSupplyRelativeRef } from '../../cli/supply-root';
import {
  SupplyDuplicateGroupError,
  SupplyDuplicateSkillNameError,
  SupplyGroupEmptyError,
  SupplyGroupNotFoundError,
  SupplyRefInvalidError,
  SupplyRootNotFoundError,
  SupplySourceUnreadableError,
  SupplyUnsupportedEntryError,
} from '../../application/ports';

/** 目录约定里那两个固定名字。只写一次，扫描与 `sourceRef` 拼接共用。 */
const SKILLS_DIR_NAME = 'skills';
const SKILL_ENTRY_FILE_NAME = 'SKILL.md';

/**
 * 确定性输出的排序谓词：按 UTF-16 code unit 比较，**不是** `localeCompare`。
 * 后者的结果随 ICU 数据与运行时 locale 变化，那会让「同一库同一组集合两次运行
 * 逐字节相同」这条保证在换台机器后悄悄失效。（`tests/integration/cli-supply.test.ts`
 * 的排序用例夹具里刻意让 `Z-skill` 与 `a-skill` 并存，两种谓词结论不同，所以把
 * 这里换成 `localeCompare` 会当场红。）
 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * `[P4]` 「这个路径不存在」与「这个路径读不动」必须分开。
 *
 * 只有 `ENOENT`／`ENOTDIR`（路径的某一段压根不在，或某一段不是目录）才算「不
 * 存在」；`EACCES`／`EPERM`／`EIO`／`ELOOP` 一律原样上抛，由调用点包成
 * `SupplySourceUnreadableError`。此前这两个 helper 一律 `catch { return false }`，
 * 于是组目录上的权限错误会被报成「供给库根下没有组 X」（一句假话），而读不动的
 * `SKILL.md` 则会把整个 skill 静默丢出该组——正是这个命令存在的意义所要防的那类
 * 静默丢内容。
 */
function isMissingPath(error: unknown): boolean {
  const code = errnoCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** `lstat`（**不**跟随符号链接），不存在时返回 `null`，其余错误上抛。 */
async function lstatOrNull(absPath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(absPath);
  } catch (error) {
    if (isMissingPath(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * `[P6]` 目录项的类型判定，全模块共用同一套语义：**一律 `lstat` 语义、不跟随
 * 符号链接**。
 *
 * 此前 `SKILL.md` 那道门走 `stat`（跟随）、指纹遍历走 `dirent.isFile()`（不跟
 * 随），两处不一致的后果不是小瑕疵：一个文件全是符号链接的 skill 能过门，却给指纹
 * 贡献零字节，最终哈希出**空输入**的 sha256；而解析侧的 `cp` 仍会把内容复现过去。
 * 指纹与实际交付内容不符，就废掉了它作为 AD-22 parity 取证依据的全部意义。
 */
function describeUnsupportedEntry(entry: { isSymbolicLink(): boolean; isFIFO(): boolean; isSocket(): boolean }): string {
  if (entry.isSymbolicLink()) {
    return 'symbolic link';
  }
  if (entry.isFIFO()) {
    return 'FIFO';
  }
  if (entry.isSocket()) {
    return 'socket';
  }
  return 'special file';
}

/**
 * `dir` 内全部普通文件的相对 POSIX 路径，递归，已排序。
 *
 * `[P6]` 遇到普通文件与普通目录之外的任何项（符号链接、FIFO、设备文件）一律
 * 抛 `SupplyUnsupportedEntryError`，不再静默跳过——理由见该错误的文档串。
 */
async function collectFilesRecursively(dir: string, prefix: string, sourceRef: string): Promise<string[]> {
  const collected: string[] = [];
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix.length === 0 ? dirent.name : `${prefix}/${dirent.name}`;
    if (dirent.isDirectory()) {
      collected.push(...(await collectFilesRecursively(path.join(dir, dirent.name), relative, sourceRef)));
      continue;
    }
    if (dirent.isFile()) {
      collected.push(relative);
      continue;
    }
    throw new SupplyUnsupportedEntryError(sourceRef, relative, describeUnsupportedEntry(dirent));
  }
  return collected.sort(compareCodeUnits);
}

/** 长度前缀用的 8 字节大端整数。 */
function uint64BE(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

/**
 * 一个 skill 目录的 sha256。它不是装饰：AD-22 退役第 (2) 步的 parity 取证要
 * 「真实烟雾对照」，而 `sourceRef` 只标识*位置*、不标识*内容*——指纹是唯一能证明
 * 两台机器复现出同一批字节的字段（同时也是 `fork` 组零改动可机械验证的依据）。
 *
 * 喂入的是**目录内全部文件**（不只 `SKILL.md`）：解析侧 `content-materializer.ts`
 * 复制的就是整个目录，指纹的覆盖面必须与被物化的东西一致，否则改动一个附件不会
 * 改变指纹。
 *
 * `[P10]` 编码是**长度前缀**，不是分隔符：每个文件喂入
 * `u64be(路径字节数) + 路径字节 + u64be(内容字节数) + 内容字节`。此前用 NUL 分隔，
 * 并在注释里声称「路径与内容都不可能含 NUL」——对内容而言这话是错的，附件本来就
 * 可以是二进制、当然可能含 `0x00`，那个编码不是单射的。长度前缀无条件单射，
 * 于是「文件名 `ab` + 内容 `c`」与「文件名 `a` + 内容 `bc`」必然算出不同的值。
 * 路径本身参与，因此「只改文件名、不改字节总集」同样会改变指纹。内容按**字节**
 * 喂入、不按文本解码——任何解码或换行规范化都会引入平台差异。
 *
 * **覆盖边界（如实声明，不夸大）**：摘要覆盖普通文件的相对路径与字节内容，
 * 仅此而已。它**不**覆盖空目录、可执行位与其余 mode 位、属主、时间戳——而解析侧的
 * `cp` 会复现其中一部分（例如空目录与 mode）。也就是说，指纹相同能证明「全部普通
 * 文件的路径与内容相同」，不能证明「两棵目录树逐位相同」。符号链接等不可复现项
 * 不在此列，因为它们在上面已被硬拒绝。
 *
 * `createHash('sha256')` 沿用 `adapters/self-update/checksum.ts` 与
 * `github-release-updater.ts` 的既有 `node:crypto` 先例，不引第二套哈希实现。
 */
async function fingerprintDirectory(dir: string, sourceRef: string): Promise<string> {
  const hash = createHash('sha256');
  for (const relativePath of await collectFilesRecursively(dir, '', sourceRef)) {
    const pathBytes = Buffer.from(relativePath, 'utf8');
    const contentBytes = await readFile(path.join(dir, relativePath));
    hash.update(uint64BE(pathBytes.byteLength));
    hash.update(pathBytes);
    hash.update(uint64BE(contentBytes.byteLength));
    hash.update(contentBytes);
  }
  return hash.digest('hex');
}

/**
 * `[Story 3.5]` 产出侧自检的唯一入口：把一条**声明的**库内相对引用换成它的
 * 规范化形态，不通过就抛（fail-closed），绝不退化成「先产出、等读侧再拒」。
 * 判定用的是解析侧用的同一个 `validateSupplyRelativeRef`；失败时抛出的是结构化
 * 的三元组，成句交给 `cli/render.ts` 按语言组装（见 `SupplyRefInvalidError`）。
 *
 * 纯词法、无 I/O，因此可以在任何 `stat`／`readdir` **之前**跑完。
 */
function normalizeSupplyRef(declaredRef: string, supplyRoot: string): { readonly ref: string; readonly path: string } {
  const verdict = validateSupplyRelativeRef(declaredRef, supplyRoot);
  if (!verdict.ok) {
    throw new SupplyRefInvalidError(declaredRef, supplyRoot, verdict.why);
  }
  return { ref: verdict.ref, path: verdict.path };
}

/**
 * `[Story 3.5]` 供给库里的 Skill 全部来自「组」这个装配单元，与 `cap-fs.ts` 把
 * `lock.json` 的 `project_skill_imports` 记成 `project-skill-import` 是同一件事
 * ——第三方字节被复现进本项目的供给面，而不是本项目自己写的能力。
 */
const SUPPLY_SOURCE_CATEGORY: SourceCategory = 'project-skill-import';

/**
 * 一条候选里所有 `Unknown` 字段共用的固定时间戳。`new Date()` 会让「两次运行
 * 逐字节相同」当场失效，所以这里与 `application/establish.ts` 的
 * `MISSING_FIELD_OBSERVED_AT` 用同一个 epoch 常量。
 */
const SUPPLY_OBSERVED_AT = new Date(0).toISOString();

/**
 * `[P3]` 扫描结果同时带回**规范化并排序后的组 ref**，而不只是 skill 列表。
 * `scopeBoundary` 必须由它构成：用原始的、按用户书写顺序排列的 `--group` 值，会让
 * `--group alpha --group beta` 与 `--group beta --group alpha` 产出不同字节，而
 * 冻结区要求的是「同一库同一组**集合**两次运行逐字节相同」——集合，与书写顺序无关。
 */
export interface SupplyScanResult {
  readonly groupRefs: readonly string[];
  readonly skills: readonly CapabilityReference[];
}

/** 把一段扫描期的裸 I/O 失败包成典型化错误；已经典型化的原样放行。 */
function asTypedSupplyFailure(error: unknown, where: string, supplyRoot: string): unknown {
  if (
    error instanceof SupplyGroupNotFoundError ||
    error instanceof SupplyGroupEmptyError ||
    error instanceof SupplyRefInvalidError ||
    error instanceof SupplyUnsupportedEntryError ||
    error instanceof SupplySourceUnreadableError
  ) {
    return error;
  }
  const reason = error instanceof Error ? error.message : String(error);
  return new SupplySourceUnreadableError(where, supplyRoot, reason);
}

/**
 * 按目录约定扫描 `groupNames` 里**显式声明**的每一个组。
 *
 * 白名单语义（负责人 2026-08-25 确认）：只产出显式声明的组，未声明的组不存在
 * ——本函数从不枚举 `supplyRoot` 下有哪些组。
 *
 * 执行次序是刻意的：**先跑完全部纯词法判定，再碰文件系统**。
 *   1. 逐个规范化组名（`SupplyRefInvalidError`）；
 *   2. 按规范化 ref 去重（`SupplyDuplicateGroupError`）；
 *   3. 根是否为目录（`SupplyRootNotFoundError`）；
 *   4. 逐组扫描（`SupplyGroupNotFoundError`／`SupplyGroupEmptyError`／
 *      `SupplyUnsupportedEntryError`／`SupplySourceUnreadableError`）；
 *   5. 跨组同名 skill 检出（`SupplyDuplicateSkillNameError`）。
 *
 * (1)/(2) 在前，于是 `--group ../../etc` 这类逃逸在任何 `readdir`／`lstat` 之前
 * 就被拒掉，而且一个用法层面的错误不会被一个先冒出来的 I/O 错误盖住。
 *
 * `[P10]` 一句此前写过头的话在此更正：这**不是**「扫描范围在构造上限死在根内」的
 * 构造保证。`validateSupplyRelativeRef` 是纯词法的（不做 `realpath`），根内一个
 * 指向根外的符号链接照样会被跟随。它保证的是「声明的引用字符串本身不逃逸」，
 * 真正兜住符号链接的是 (4) 里对符号链接的硬拒绝。
 *
 * (5) 放在最后、且在排序之后：跨组同名 skill 会让解析侧静默覆盖内容，必须整体
 * 失败（理由见 `SupplyDuplicateSkillNameError`）；排序后再查，报出来的那一对才与
 * 用户的书写顺序无关。
 */
export async function loadSupplyGroups(supplyRoot: string, groupNames: readonly string[]): Promise<SupplyScanResult> {
  // (1)+(2) 纯词法阶段。
  const declaredByRef = new Map<string, string>();
  const groups: Array<{ readonly ref: string; readonly path: string }> = [];
  for (const groupName of groupNames) {
    const group = normalizeSupplyRef(groupName, supplyRoot);
    const firstDeclared = declaredByRef.get(group.ref);
    if (firstDeclared !== undefined) {
      throw new SupplyDuplicateGroupError(group.ref, firstDeclared, groupName);
    }
    declaredByRef.set(group.ref, groupName);
    groups.push(group);
  }
  groups.sort((a, b) => compareCodeUnits(a.ref, b.ref));

  // (3) 根。
  try {
    const rootStat = await lstatOrNull(supplyRoot);
    if (rootStat === null || !rootStat.isDirectory()) {
      throw new SupplyRootNotFoundError(supplyRoot);
    }
  } catch (error) {
    if (error instanceof SupplyRootNotFoundError) {
      throw error;
    }
    // 根上的 `EACCES` 不是「根不存在」。
    throw asTypedSupplyFailure(error, supplyRoot, supplyRoot);
  }

  const collected: Array<{ readonly sortKey: string; readonly reference: CapabilityReference }> = [];

  // (4) 逐组扫描。
  for (const group of groups) {
    try {
      const groupStat = await lstatOrNull(group.path);
      if (groupStat === null) {
        throw new SupplyGroupNotFoundError(group.ref, supplyRoot);
      }
      if (!groupStat.isDirectory()) {
        // 组目录位置上是个符号链接或普通文件：既不是「不存在」，也不能当目录扫。
        throw groupStat.isSymbolicLink()
          ? new SupplyUnsupportedEntryError(group.ref, '.', describeUnsupportedEntry(groupStat))
          : new SupplyGroupNotFoundError(group.ref, supplyRoot);
      }

      const skillsDir = path.join(group.path, SKILLS_DIR_NAME);
      const skillNames: string[] = [];
      const skillsDirStat = await lstatOrNull(skillsDir);
      // 组目录存在但没有 `skills/` 子目录，与「有 `skills/` 但里面没有一个合规
      // skill 目录」是同一件事：这个组拿不出内容。两者都落到下面的空组判定。
      if (skillsDirStat !== null && skillsDirStat.isDirectory()) {
        for (const dirent of await readdir(skillsDir, { withFileTypes: true })) {
          if (dirent.isFile()) {
            // `skills/` 下的散装文件（README、LICENSE）不是 skill，正常忽略。
            continue;
          }
          if (!dirent.isDirectory()) {
            // 符号链接指向的 skill 目录会被 `cp` 按链接复制、却无法被可复现地
            // 摘要——静默跳过等于静默少一个 skill，所以硬拒绝。
            throw new SupplyUnsupportedEntryError(
              `${group.ref}/${SKILLS_DIR_NAME}`,
              dirent.name,
              describeUnsupportedEntry(dirent),
            );
          }
          const entryStat = await lstatOrNull(path.join(skillsDir, dirent.name, SKILL_ENTRY_FILE_NAME));
          if (entryStat === null) {
            // 缺 `SKILL.md` 的目录不计入（不是错误——供给库里放个 `LICENSES/`
            // 之类的旁支目录很正常）；若因此使该组为空，由下面的空组判定接手。
            continue;
          }
          if (entryStat.isSymbolicLink()) {
            // 符号链接的 `SKILL.md` 此前能过门（那道门走的是跟随链接的 `stat`），
            // 却在指纹遍历里被当成非普通文件跳过——skill 计入了，内容却没计入。
            throw new SupplyUnsupportedEntryError(
              `${group.ref}/${SKILLS_DIR_NAME}/${dirent.name}`,
              SKILL_ENTRY_FILE_NAME,
              describeUnsupportedEntry(entryStat),
            );
          }
          if (!entryStat.isFile()) {
            // `SKILL.md` 位置上是个目录之类：这不是一个 skill 目录，与「没有
            // SKILL.md」同等对待，不计入。
            continue;
          }
          skillNames.push(dirent.name);
        }
      }

      if (skillNames.length === 0) {
        throw new SupplyGroupEmptyError(group.ref, supplyRoot);
      }

      for (const skillName of skillNames) {
        const skill = normalizeSupplyRef(`${group.ref}/${SKILLS_DIR_NAME}/${skillName}`, supplyRoot);
        collected.push({
          sortKey: `${group.ref}/${skillName}`,
          reference: {
            kind: 'skill',
            name: skillName,
            sourceCategory: known(SUPPLY_SOURCE_CATEGORY),
            // 与 `cap-fs.ts` 的 `mapCapabilityNames` 同一句式，供给侧不另发明措辞。
            summary: known(`skill reference: ${skillName}`),
            sourceRef: known(skill.ref),
            contentFingerprint: known(`sha256:${await fingerprintDirectory(skill.path, skill.ref)}`),
          },
        });
      }
    } catch (error) {
      throw asTypedSupplyFailure(error, group.ref, supplyRoot);
    }
  }

  // `readdir` 的返回顺序既不保证也不跨平台一致，组之间的先后又取决于用户敲
  // `--group` 的顺序——最终排序放在这里做一次，是「两次运行逐字节相同」这条保证
  // 唯一的落点。
  collected.sort((a, b) => compareCodeUnits(a.sortKey, b.sortKey));

  // (5) 跨组同名 skill。
  const sourceRefByName = new Map<string, string>();
  for (const entry of collected) {
    const name = entry.reference.name;
    const sourceRef = entry.reference.sourceRef.kind === 'known' ? entry.reference.sourceRef.value : entry.sortKey;
    const firstSourceRef = sourceRefByName.get(name);
    if (firstSourceRef !== undefined) {
      throw new SupplyDuplicateSkillNameError(name, firstSourceRef, sourceRef);
    }
    sourceRefByName.set(name, sourceRef);
  }

  return { groupRefs: groups.map((group) => group.ref), skills: collected.map((entry) => entry.reference) };
}

/**
 * `[Story 3.5]` 候选 JSON 的可序列化形状。刻意不是 `StableConfigRevision`：
 * `revisionId`/`triggerCategory`/`evidenceRef`/`supersedesRevisionId` 都不由供给侧
 * 决定（前者由写端口生成，后三者由 `configs establish` 的 flag 提供），
 * 这里产出的正是 `application/establish.ts` 的 `parseCandidateRevision`
 * 所接受的那一组字段，一个不多。
 */
export interface SupplyCandidate {
  readonly configName: string;
  readonly defaultMarker: Fact<boolean>;
  readonly scopeBoundary: Fact<string>;
  readonly availability: Fact<'resolved'>;
  readonly skills: readonly CapabilityReference[];
}

/**
 * 把扫描结果装成候选。三个标量字段的取值都是「已知的就说已知，不知道的就说不
 * 知道」（AD-8），没有一个是编出来的：
 *
 * - `defaultMarker`：供给库里根本没有「这份配置是不是默认」这个信号，因此是诚实的
 *   `Unknown`。写成 `Known(false)`（更别说 `Known(true)`）才是伪造。
 * - `scopeBoundary`：本次装配确实由这批组构成，这是真实且确定的事实。
 * - `availability`：每一个被声明的组都已机械解析成功——否则本函数根本不会被调用
 *   （上游 fail-closed 抛错），所以 `'resolved'` 是真的。
 *
 * `[P3]` `groupRefs` 必须是 `loadSupplyGroups` 回传的那份**规范化并排序**过的，
 * 不是原始 argv：否则同一个组集合换个书写顺序就会产出不同字节。
 */
export function buildSupplyCandidate(configName: string, scan: SupplyScanResult): SupplyCandidate {
  return {
    configName,
    defaultMarker: unknown('not-decided-by-configs-supply', SUPPLY_OBSERVED_AT),
    scopeBoundary: known(`configs supply: groups ${scan.groupRefs.join(', ')}`),
    availability: known('resolved'),
    skills: scan.skills,
  };
}
