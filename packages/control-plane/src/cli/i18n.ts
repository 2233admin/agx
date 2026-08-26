/**
 * Bilingual (zh/en) text table for the CLI's user-readable strings
 * (EXPERIENCE.md "Voice and Tone" -- 文案对照表 as the starting point,
 * extended by analogy in the same tone for strings the table doesn't
 * enumerate).
 *
 * `resolveLang()` reads `CONFIGS_LANG` fresh on every call (never cached)
 * -- default `zh`, `CONFIGS_LANG=en` switches to English. It never falls
 * back to `LANG`/`LC_ALL` (Voice and Tone: explicit env var over implicit
 * system locale, same mental model as `NO_COLOR`).
 *
 * Command names, subcommands, flags, `CONFIGS_LANG` itself, and closed
 * enum values (`LaunchPlan.phase`, `ComparisonStatus`, `SourceCategory`,
 * and `computeKnownDifferences`' reason codes) are never translated --
 * they are stable, potentially `grep`-matched identifiers, not
 * explanatory prose (same reasoning as argv/env-var syntax).
 */

export type Lang = 'zh' | 'en';

export function resolveLang(): Lang {
  return process.env.CONFIGS_LANG === 'en' ? 'en' : 'zh';
}

type Dict = Record<string, string>;

const zh: Dict = {
  'emptyList.line1': '未找到已保存的配置修订版本。',
  'emptyList.line2': '本工具只读取已存储在 SQLite 里的配置修订版本；',
  'emptyList.line3': '它自己不创建、不导入、不提供任何配置。',

  'capabilityGroup.instruction': '指令：',
  'capabilityGroup.skill': '技能：',
  'capabilityGroup.mcp': 'MCP：',
  'capabilityGroup.hook': '钩子：',
  'capabilityGroup.plugin': '插件：',
  'capabilityGroup.emptySingle': '（未配置）',
  'capabilityGroup.emptyCompare': '（比较的修订版本中均未配置）',

  'fact.unknown': '未知（{reason}，记录于 {observedAt}）',
  'fact.available': '可用',
  'marker.default': '默认',
  'marker.generic': '通用',
  'capabilityRef.source': '来源',
  'capabilityRef.sourceRef': '来源引用',
  'capabilityRef.contentFingerprint': '内容指纹',

  'list.revisionLabel': '修订版本',
  'list.statusLabel': '状态',
  'list.boundaryLabel': '边界',

  'detail.configuration': '配置：',
  'detail.revision': '修订版本：',
  'detail.status': '状态：',
  'detail.boundary': '边界：',
  'detail.triggerCategory': '触发类别：',
  'detail.evidenceRef': '证据引用：',
  'detail.supersededFrom': '替代自：',
  'detail.supersededBy': '后继：',
  'detail.chainNone': '（无）',
  'detail.chainUnresolvable': '无法解析（{revisionId}）',

  'queryFailure.notFound': '未找到。恢复：运行 `configs list` 查看可用的修订版本 id。',
  'queryFailure.unsupported': '不受支持（{reason}）。恢复：重新导入该修订版本，或检查其存储数据；其他配置不受影响。',
  'queryFailure.prefix': '配置 "{revisionId}"：{reason}',

  'comparison.header': '正在比较 {count} 个修订版本：{ids}',
  'comparison.missingIn': '缺失于：{ids}',
  'comparison.noValid': '没有解析出任何可比较的有效配置修订版本。',
  'comparison.unresolvedTitle': '未解析的 id：',

  'confirmation.lead': '即将使用配置 "{configName}"（修订版本 {revisionId}）启动 OMP。',
  'confirmation.client': '客户端：{client}  版本：{version}',
  'confirmation.knownDifferencesTitle': '已知差异（本 MVP 不会完整应用）：',
  'confirmation.forwardedTitle': '在 `--` 之后原样转发给 `omp`：',
  'confirmation.closing': '这是本次启动计划的一次性确认——之后不会再询问。',
  'confirmation.prompt': '是否继续启动？[y/N] ',

  'launchStatus.revision': '修订版本：{revisionId}',
  'launchStatus.client': '客户端：{client}',
  'launchStatus.clientVersion': '客户端版本：{version}',
  'launchStatus.phase': '阶段：{phase}',
  'launchStatus.applyResult': '应用结果：{result}',
  'launchStatus.knownDifferencesTitle': '已知差异：',
  'launchStatus.knownDifferencesNone': '已知差异：（无）',

  'unsupportedClient': '客户端 "{clientId}" 暂不支持：{reason}',

  'failure.cancelled': '启动计划 {planId} 已取消：{reason}。',
  'failure.notStarted': 'OMP 未启动。',
  'failure.incomplete': '启动计划 {planId} 未完成。',
  'failure.failed': '启动计划 {planId} 失败。',
  'failure.phase': '阶段：{phase}',
  'failure.reason': '原因：{reason}',
  'failure.recovery': '恢复建议：请查看上方原因；运行 `configs show {revisionId}` 重新核查该配置，问题解决后运行 `configs use {revisionId}` 重试。',

  // `[Story 4.6 review fix]` `ClaudeLaunchOutcome` carries a
  // failure-kind-specific `recoveryAction`/`affectedCapabilities` that
  // `failure.recovery`'s generic, static text does not surface -- shown as
  // extra lines appended after `renderLaunchFailure`'s output, never
  // replacing it.
  'claudeFailure.recoveryAction': 'Claude 恢复建议：{recoveryAction}',
  'claudeFailure.affectedCapabilities': '受影响能力：{capabilities}',

  'switchAccepted.requiresRestart': '当前 OMP 进程（计划 {previousPlanId}）现在需要重启才能使用新配置。',
  'switchAccepted.newPlan': '已为修订版本 {revisionId} 创建新的启动计划（{planId}），等待新的确认。',
  'switchAccepted.noAutoResume': '当前进程不会被原地修改，也不会自动恢复。',

  'handoffLine': '终端控制权已交给 omp——直到它退出前，这个终端都是 omp 的。',

  'tui.knownDifferencesMarker': '（有已知差异）',
  'tui.listFooter': '↑↓ 选择 · enter 启动 · → 详情 · q 退出',
  'tui.detailFooter': 'enter 启动 · esc 返回 · q 退出',

  'usage.prefix': '用法：',
  'parseError.missingId': 'configs {command} <id>：缺少 <id>',
  'parseError.compareMinIds': 'configs compare <id> <id> [...ids]：至少需要 2 个 id',
  'parseError.clientRequiresValue': '--client 需要一个值',
  'parseError.unknownFlag': '未知参数：{flag}',
  'parseError.unknownClient': '未知客户端：{client}',
  'parseError.unknownCommand': '未知命令：{command}',
  'parseError.denylistedForwardedArg':
    'configs {command}：转发参数 "{arg}" 不被允许——如果原样传给真实的 `omp` 二进制文件，会破坏本 Story 单一扩展来源/复用默认 profile/不自动恢复这几条保证',
  // `[Story 4.6 review fix]` `claude-code` has no forwarded-args delivery
  // mechanism (`launchClaudeFresh`/`ClaudeSpawnParams` never accept one) --
  // rejected here with a typed usage error instead of being silently
  // dropped.
  'parseError.forwardedArgsUnsupportedForClaude':
    'configs {command}：`--client claude-code` 尚不支持在 `--` 之后转发参数',
  'openDeps.failed': 'configs：无法打开配置存储：{message}',
  'unexpectedFailure': 'configs：意外失败：{message}',
  'launchPlan.notFound': '未找到启动计划 {target}。请先运行 `configs use <id>`。',
  'launchPlan.notFoundTargetForId': '（id 为 "{planId}"）',
  'launchPlan.notFoundTargetNoActive': '（客户端 "omp" 没有活跃的启动计划）',

  'parseError.establishFlagRequiresValue': '{flag} 需要一个值',
  'parseError.establishFlagRepeated': '{flag} 只能传一次',

  // `[Story 3.5]` `configs supply` 的三个用法错误（退出 2）。`--group` 可以传
  // 多次（一次装配多个组），所以它不复用 `establishFlagRepeated`——重复的是
  // *同一个组名*，不是 flag 本身。
  'parseError.supplyMissingConfigName': 'configs supply：缺少 --config-name <name>',
  'parseError.supplyMissingGroup': 'configs supply：至少需要一个 --group <group>',
  // `[P7]` 空的 --group 值（或只有空白）与空的 --config-name 值同属一类用户错误，
  // 因此同样在 parse 阶段判掉、同样退出 2，而不是拖到运行期变成退出 1。
  'parseError.supplyEmptyGroup': 'configs supply：--group 的值不能为空',

  'establish.successPrefix': '已建立新配置修订：',
  'establish.missingTriggerCategory':
    'configs establish：缺少或不合法的触发类别——必须通过 --trigger-category 传入 new-scenario / known-insufficiency / bad-case 之一；未写入任何内容。',
  'establish.missingEvidence': 'configs establish：缺少证据引用——必须通过 --evidence <ref> 传入非空值；未写入任何内容。',
  'establish.noCandidateSource':
    'configs establish：未提供候选内容——请传入 --from <path>，或通过 stdin 管道输入候选 JSON（当前 stdin 是交互式终端）；未写入任何内容。',
  'establish.invalidCandidate': 'configs establish：候选内容不合法（以下为英文字段路径/类型提示，非待翻译文案）：`{reason}`；未写入任何内容。',

  'revise.successPrefix': '已建立替代修订：',
  'revise.missingSupersedes': 'configs revise：缺少 --supersedes 目标修订 id——必须通过 --supersedes <revisionId> 传入非空值；未写入任何内容。',
  'revise.supersedesNotFound': 'configs revise：--supersedes 指向的修订 "{revisionId}" 不存在；未写入任何内容。',
  'revise.supersedesConfigMismatch':
    'configs revise：--supersedes 指向的修订 "{revisionId}" 属于配置 "{actual}"，与候选内容的配置 "{expected}" 不一致；未写入任何内容。',
  'revise.supersedesConflict': 'configs revise：--supersedes 指向的修订 "{revisionId}" 已被另一条修订替代；未写入任何内容。',

  // `[Story 3.5]` `configs supply` 的四个 fail-closed 拒绝（AD-10）。四条文案
  // 都以「未产出任何候选」收尾：`supply` 的正常产出会被管道喂给
  // `configs establish`，所以「什么都没产出」这件事必须说死，用户才不会以为
  // 管道那头拿到了一份不完整的候选。
  'supply.rootNotFound': 'configs supply：供给库根 `{supplyRoot}` 不存在或不是目录——请检查 CONTROL_PLANE_SUPPLY_ROOT；未产出任何候选。',
  // `[P10]` 与同表邻居一致，两条都补上恢复指引——此前只有 rootNotFound 有。
  'supply.groupNotFound':
    'configs supply：供给库根 `{supplyRoot}` 下没有组 "{group}"。恢复：确认组目录 `{supplyRoot}/{group}` 存在，或检查 CONTROL_PLANE_SUPPLY_ROOT 是否指向了预期的库根；未产出任何候选。',
  'supply.groupEmpty':
    'configs supply：组 "{group}"（供给库根 `{supplyRoot}`）下没有任何含 SKILL.md 的 skill 目录——声明了却拿不到内容视为错误，不是空集。恢复：供给库的目录约定是 `<组>/skills/<skill>/SKILL.md`，请确认 `{group}/skills/` 之下至少有一个含 SKILL.md 的目录；未产出任何候选。',
  'supply.refInvalid': 'configs supply：产出自检失败——{reason}；未产出任何候选。',
  'supply.duplicateGroup':
    'configs supply：组 "{group}" 被声明了不止一次（`{first}` 与 `{second}` 规范化后是同一个组）。恢复：每个组只传一次 --group；未产出任何候选。',
  'supply.duplicateSkillName':
    'configs supply：skill 名 "{skill}" 同时来自两个组（`{first}` 与 `{second}`）——物化时两者会落在同一个目标目录、后者静默覆盖前者，因此拒绝产出。恢复：本次装配只选其中一个组，或先在供给库里消除同名；未产出任何候选。',
  'supply.sourceUnreadable':
    'configs supply：读取 `{where}`（供给库根 `{supplyRoot}`）失败：{reason}。恢复：这是 I/O 失败而不是「没有这个东西」，请检查权限以及该路径是否正被并发改动；未产出任何候选。',
  'supply.unsupportedEntry':
    'configs supply：`{sourceRef}` 下的 `{entryPath}` 是{entryKind}，无法可复现地计入内容指纹——指纹覆盖不到的内容仍会被物化侧照样复制，指纹便不再能作为 parity 取证依据。恢复：把它换成普通文件或普通目录；未产出任何候选。',

  // `[P9]` sourceRef 合同拒绝的成句模板。zh 侧与 `cli/supply-root.ts` 的
  // `describeSupplyRefRejection` **逐字相同**（有测试做等值断言），en 侧是同结构
  // 的英文句——此前直接透传那个硬编码中文常量，en 模式下会渲染出中英混排。
  'supplyRef.rejection':
    'sourceRef 违反跨机器可移植性合同（{why}）：只接受供给库内的相对 POSIX 路径；实际值 `{value}`，当前生效的供给根 `{supplyRoot}`',
  'supplyRef.why.empty': '为空',
  'supplyRef.why.backslash': '含反斜杠',
  'supplyRef.why.driveLetter': '带盘符前缀',
  'supplyRef.why.absolute': '是绝对路径',
  'supplyRef.why.outsideRoot': '解析后未落在供给根之内',

  'selfUpdate.updated': 'configs：已更新到 v{version}（当前已生效）',
};

const en: Dict = {
  'emptyList.line1': 'No saved configuration revisions found.',
  'emptyList.line2': 'This CLI only reads configuration revisions already stored in SQLite;',
  'emptyList.line3': 'it does not create, import or supply configuration on its own.',

  'capabilityGroup.instruction': 'Instructions:',
  'capabilityGroup.skill': 'Skills:',
  'capabilityGroup.mcp': 'MCP:',
  'capabilityGroup.hook': 'Hooks:',
  'capabilityGroup.plugin': 'Plugins:',
  'capabilityGroup.emptySingle': '(none configured)',
  'capabilityGroup.emptyCompare': '(none in any compared revision)',

  'fact.unknown': 'Unknown ({reason}, observed {observedAt})',
  'fact.available': 'available',
  'marker.default': 'default',
  'marker.generic': 'generic',
  'capabilityRef.source': 'source',
  'capabilityRef.sourceRef': 'source ref',
  'capabilityRef.contentFingerprint': 'content fingerprint',

  'list.revisionLabel': 'revision',
  'list.statusLabel': 'status',
  'list.boundaryLabel': 'boundary',

  'detail.configuration': 'Configuration:',
  'detail.revision': 'Revision:',
  'detail.status': 'Status:',
  'detail.boundary': 'Boundary:',
  'detail.triggerCategory': 'Trigger category:',
  'detail.evidenceRef': 'Evidence ref:',
  'detail.supersededFrom': 'Superseded from:',
  'detail.supersededBy': 'Superseded by:',
  'detail.chainNone': '(none)',
  'detail.chainUnresolvable': 'unresolvable ({revisionId})',

  'queryFailure.notFound': 'not found. Recovery: run `configs list` to see available revision ids.',
  'queryFailure.unsupported': 'unsupported ({reason}). Recovery: re-seed this revision or inspect its stored data; other configurations are unaffected.',
  'queryFailure.prefix': 'Configuration "{revisionId}": {reason}',

  'comparison.header': 'Comparing {count} revision(s): {ids}',
  'comparison.missingIn': 'missing in: {ids}',
  'comparison.noValid': 'No valid configuration revisions were resolved to compare.',
  'comparison.unresolvedTitle': 'Unresolved ids:',

  'confirmation.lead': 'About to launch OMP with configuration "{configName}" (revision {revisionId}).',
  'confirmation.client': 'Client: {client}  version: {version}',
  'confirmation.knownDifferencesTitle': 'Known differences (will not be fully applied in this MVP):',
  'confirmation.forwardedTitle': 'Forwarded to `omp` verbatim after `--`:',
  'confirmation.closing': 'This is a one-time confirmation for this launch plan -- nothing else will ask again.',
  'confirmation.prompt': 'Proceed with this launch? [y/N] ',

  'launchStatus.revision': 'Revision: {revisionId}',
  'launchStatus.client': 'Client: {client}',
  'launchStatus.clientVersion': 'Client version: {version}',
  'launchStatus.phase': 'Phase: {phase}',
  'launchStatus.applyResult': 'Apply result: {result}',
  'launchStatus.knownDifferencesTitle': 'Known differences:',
  'launchStatus.knownDifferencesNone': 'Known differences: (none)',

  'unsupportedClient': 'Client "{clientId}" is not supported yet: {reason}',

  'failure.cancelled': 'Launch plan {planId} was cancelled: {reason}.',
  'failure.notStarted': 'OMP was not started.',
  'failure.incomplete': 'Launch plan {planId} did not complete.',
  'failure.failed': 'Launch plan {planId} failed.',
  'failure.phase': 'Phase: {phase}',
  'failure.reason': 'Reason: {reason}',
  'failure.recovery': 'Recovery: inspect the reason above; run `configs show {revisionId}` to re-check the configuration, then `configs use {revisionId}` to retry once resolved.',

  'claudeFailure.recoveryAction': 'Claude recovery: {recoveryAction}',
  'claudeFailure.affectedCapabilities': 'Affected capabilities: {capabilities}',

  'switchAccepted.requiresRestart': 'Current OMP process (plan {previousPlanId}) now requires a restart to use a new configuration.',
  'switchAccepted.newPlan': 'A new launch plan ({planId}) was created for revision {revisionId} and awaits a fresh confirmation.',
  'switchAccepted.noAutoResume': 'The current process is not modified in place and will not auto-resume.',

  'handoffLine': "Handing off to omp — this terminal is omp's until it exits.",

  'tui.knownDifferencesMarker': '(has known differences)',
  'tui.listFooter': '↑↓ select · enter use · → details · q quit',
  'tui.detailFooter': 'enter use · esc back · q quit',

  'usage.prefix': 'usage:',
  'parseError.missingId': 'configs {command} <id>: missing <id>',
  'parseError.compareMinIds': 'configs compare <id> <id> [...ids]: requires at least 2 ids',
  'parseError.clientRequiresValue': '--client requires a value',
  'parseError.unknownFlag': 'unknown flag: {flag}',
  'parseError.unknownClient': 'unknown client: {client}',
  'parseError.unknownCommand': 'unknown command: {command}',
  'parseError.denylistedForwardedArg':
    "configs {command}: forwarded argument \"{arg}\" is not allowed -- it would defeat this Story's single-extension-source/default-profile/no-auto-resume guarantees when passed through to the real `omp` binary",
  'parseError.forwardedArgsUnsupportedForClaude':
    'configs {command}: forwarded arguments after `--` are not supported yet with `--client claude-code`',
  'openDeps.failed': 'configs: could not open configuration storage: {message}',
  'unexpectedFailure': 'configs: unexpected failure: {message}',
  'launchPlan.notFound': 'No launch plan found {target}. Run `configs use <id>` first.',
  'launchPlan.notFoundTargetForId': 'for id "{planId}"',
  'launchPlan.notFoundTargetNoActive': '(no active plan for client "omp")',

  'parseError.establishFlagRequiresValue': '{flag} requires a value',
  'parseError.establishFlagRepeated': '{flag} can only be passed once',

  'parseError.supplyMissingConfigName': 'configs supply: missing --config-name <name>',
  'parseError.supplyMissingGroup': 'configs supply: at least one --group <group> is required',
  'parseError.supplyEmptyGroup': 'configs supply: --group requires a non-empty value',

  'establish.successPrefix': 'Established new configuration revision:',
  'establish.missingTriggerCategory':
    'configs establish: trigger category is missing or invalid -- pass one of new-scenario / known-insufficiency / bad-case via --trigger-category; nothing was written.',
  'establish.missingEvidence': 'configs establish: evidence reference is missing -- pass a non-empty value via --evidence <ref>; nothing was written.',
  'establish.noCandidateSource':
    'configs establish: no candidate source was provided -- pass --from <path>, or pipe candidate JSON via stdin (stdin is currently an interactive terminal); nothing was written.',
  'establish.invalidCandidate': 'configs establish: candidate is invalid: `{reason}`; nothing was written.',

  'revise.successPrefix': 'Established superseding revision:',
  'revise.missingSupersedes': 'configs revise: missing --supersedes target revision id -- pass a non-empty value via --supersedes <revisionId>; nothing was written.',
  'revise.supersedesNotFound': 'configs revise: supersedes target revision "{revisionId}" was not found; nothing was written.',
  'revise.supersedesConfigMismatch':
    'configs revise: supersedes target revision "{revisionId}" belongs to configuration "{actual}", which does not match the candidate\'s configuration "{expected}"; nothing was written.',
  'revise.supersedesConflict': 'configs revise: supersedes target revision "{revisionId}" has already been superseded by another revision; nothing was written.',

  'supply.rootNotFound':
    'configs supply: supply library root `{supplyRoot}` does not exist or is not a directory -- check CONTROL_PLANE_SUPPLY_ROOT; nothing was produced.',
  'supply.groupNotFound':
    'configs supply: no group "{group}" under supply library root `{supplyRoot}`. Recovery: check that the group directory `{supplyRoot}/{group}` exists, or that CONTROL_PLANE_SUPPLY_ROOT points at the library root you meant; nothing was produced.',
  'supply.groupEmpty':
    'configs supply: group "{group}" (supply library root `{supplyRoot}`) contains no skill directory with a SKILL.md -- a declared group that yields nothing is an error, not an empty set. Recovery: the supply library convention is `<group>/skills/<skill>/SKILL.md`; check that `{group}/skills/` holds at least one directory with a SKILL.md; nothing was produced.',
  'supply.refInvalid': 'configs supply: produced-side self-check failed -- {reason}; nothing was produced.',
  'supply.duplicateGroup':
    'configs supply: group "{group}" was declared more than once (`{first}` and `{second}` normalize to the same group). Recovery: pass --group once per group; nothing was produced.',
  'supply.duplicateSkillName':
    'configs supply: skill name "{skill}" is supplied by two different groups (`{first}` and `{second}`) -- materialization would copy both into the same target directory, silently overwriting one with the other, so this is refused. Recovery: pick one of the two groups for this assembly, or de-duplicate the name in the supply library; nothing was produced.',
  'supply.sourceUnreadable':
    'configs supply: could not read `{where}` (supply library root `{supplyRoot}`): {reason}. Recovery: this is an I/O failure, not a "no such thing" -- check permissions and whether that path is being modified concurrently; nothing was produced.',
  'supply.unsupportedEntry':
    'configs supply: `{entryPath}` under `{sourceRef}` is a {entryKind}, which cannot be fingerprinted reproducibly -- content the fingerprint cannot cover is still copied by the materializing side, which would void the fingerprint as parity evidence. Recovery: replace it with a regular file or directory; nothing was produced.',

  'supplyRef.rejection':
    'sourceRef violates the cross-machine portability contract ({why}): only a supply-library-relative POSIX path is accepted; actual value `{value}`, effective supply root `{supplyRoot}`',
  'supplyRef.why.empty': 'empty',
  'supplyRef.why.backslash': 'contains a backslash',
  'supplyRef.why.driveLetter': 'has a drive-letter prefix',
  'supplyRef.why.absolute': 'is an absolute path',
  'supplyRef.why.outsideRoot': 'resolves outside the supply root',

  'selfUpdate.updated': 'configs: updated to v{version} (now in effect)',
};

const DICTS: Record<Lang, Dict> = { zh, en };

/**
 * Exposed only so `tests/cli/i18n.test.ts` can assert key-set parity
 * between the two dictionaries (a missing translation should be caught by
 * that test, not silently degrade to a raw dictionary key at runtime) --
 * not meant to be read by any other production code.
 */
export const dictsForTesting: Readonly<Record<Lang, Dict>> = DICTS;

export type TranslationKey = keyof typeof zh;

function otherLang(lang: Lang): Lang {
  return lang === 'en' ? 'zh' : 'en';
}

/**
 * Looks up `key` in the dictionary for the currently-resolved language and
 * substitutes any `{name}` placeholders from `params`. Values that are
 * themselves closed enum values (phase names, reason codes, ids) are always
 * passed in via `params` rather than baked into the dictionary strings, so
 * they are never accidentally translated.
 *
 * Falls back to the *other* language's dictionary (not the same one twice)
 * before falling back to the raw key -- a gap in one dictionary degrades to
 * a real, readable sentence in the other language rather than a raw
 * `dot.separated.key` leaking into user-facing output.
 *
 * Substitution is a single pass over the *template* (`String.replace` with
 * a global regex never rescans text it just inserted) rather than N
 * sequential passes -- sequential passes let one param's value, if it
 * happens to contain another param's `{name}` token (e.g. an untrusted
 * `configName` literally containing the text `{revisionId}`), get
 * re-substituted by a later param.
 */
export function t(key: TranslationKey, params?: Readonly<Record<string, string | number>>): string {
  const lang = resolveLang();
  const template = DICTS[lang][key] ?? DICTS[otherLang(lang)][key] ?? key;
  if (params === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}
