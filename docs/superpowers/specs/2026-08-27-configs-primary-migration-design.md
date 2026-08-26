---
title: Agent System X Project configs-primary migration design
status: proposed
date: 2026-08-27
owner: 项目负责人
source:
  - docs/superpowers/specs/2026-08-26-agent-system-x-merge-design.md
  - docs/superpowers/plans/2026-08-26-agent-system-x-merge.md
---

# Agent System X Project：configs-primary 迁移设计

## 1. 结论先行

本设计取代 2026-08-26 的“AGX + configs sidecar”薄集成范围。最终目标是由上游 `configs` 成为唯一的用户入口、配置状态运行时和生命周期状态权威；AGX 的有价值业务能力迁移到 `configs` 的新架构中。迁移完成后：

- 用户使用 `configs` CLI，不再依赖旧 AGX installer 作为安装控制面；
- 配置修订和部署生命周期状态统一进入 `configs` 的 SQLite/state store；
- GitHub 仓库、GitHub Project、Provider、Multica、Evidence、初始化、激活、Bootstrap、first-use、恢复、诊断、升级、回滚和卸载都由新的 `configs` 架构承载；
- 删除 AGX 本地 Bundle 下载/解包、`agent-plugins` archive 安装流程和 `configs` runtime sidecar；
- 不保留长期双写、双 Receipt、双套 drift evaluator 或两个互相独立的用户入口。

这不是把 AGX 代码原样复制到上游，也不是继续维护两个 runtime。它是一次有明确删除终点的业务能力迁移。旧 AGX 安装只能作为一次性迁移输入，不再是目标架构的运行时依赖。

### 当前前置事实

截至 2026-08-27，`gh api repos/2233admin/agent-systemX/releases --paginate` 返回空列表，尚未发现可验证的 `configs-v*` Release。本文不填写任何未存在的 release tag、commit、URL、checksum 或平台资产名称。因此：

- 生产切换、生产安装包和生产升级 pin 均被 Gate G0 阻塞；
- 下文的目标架构和迁移代码可以先实现，但只能使用本地 deterministic fixture、测试 Release 或受控开发包验证；
- 在 G0 通过前，现有生产 Bundle manifest 不修改，也不把 upstream `main`、本地 checkout 或 mutable URL 当作生产输入。

## 2. 背景与问题

现有 AGX 同时承担三类不应继续耦合的职责：

1. 本地 installer 下载并校验 `agent-plugins` archive，写入 `.agx/receipt.json`，管理安装目录；
2. 部署控制面创建 GitHub 仓库和 Project、激活 Codex/Claude、协调 Multica、读取 Evidence；
3. 新增的 `configs` sidecar 由 AGX receipt 绑定并通过进程桥转发。

薄集成让用户入口看似统一，实际仍有 Go installer、AGX Receipt、Bundle provenance、sidecar executable 和上游 SQLite 五个边界。它无法成为长期架构：升级、恢复、状态判定和卸载必须同时理解两套所有权，任何一方的失败都可能产生状态分裂。

目标是保留业务结果，删除旧安装控制面。`configs` 负责配置和生命周期编排；外部 GitHub、Provider、Multica 和 Agent 客户端仍各自拥有自己的外部事实；本地统一 state store 只保存必要的期望、绑定、操作和证据摘要。

## 3. 能力地图与迁移目标

### 3.1 能力分类

| 能力组 | 现有 AGX 资产/行为 | 目标 `configs` 能力 | 最终处置 |
| --- | --- | --- | --- |
| GitHub 交付 | 创建 `agent-control` / `agent-contracts`、读取仓库、创建 Project、保存 URL/visibility/revision | `configs` GitHub adapter + deployment resource model | 迁移实现；删除 AGX activation owner |
| Provider | Codex/Claude Inventory、Marketplace 激活、已有 source 冲突与 ownership | `configs` provider adapter、activation operation、ownership record | 迁移实现；保留外部 CLI 自己的凭据 |
| Multica | Workspace/Runtime/Agent selector、Task/Run readback、profile 校验 | `configs` Multica adapter + typed subject binding | 迁移实现；Multica 仍是外部事实权威 |
| Evidence | Evidence Profile、GitHub/Multica 证据采集、freshness、`verified` gate | `configs` evidence evaluator + immutable observation records | 迁移实现；禁止 runtime 成功直接产生 `verified` |
| 初始化/激活 | guided init、只读 plan、远端 mutation、部分成功恢复 | `configs init` / plan / operation journal / compensating recovery | 迁移实现；旧 `agx init` 只做过渡 handoff |
| Bootstrap/first-use | 内置模板、部署仓创建、first-use contract、Agent prompt | `configs` bootstrap package、contract renderer、first-use evidence | 迁移实现；不复制 live issue、PR、prompt transcript 或凭据 |
| 状态/诊断 | `agx status` / `diagnose`、drift、next steps、redaction | `configs status` / `diagnose`，统一本地与外部观察 | 迁移实现；删除 AGX evaluator |
| Receipt | `.agx/receipt.json` v2、owned files、binding、recovery metadata | `configs` versioned operation receipt/state records | 一次性导入后删除旧 Receipt；不长期双存 |
| 升级/回滚 | AGX Bundle/installer 边界和既有生命周期约束 | `configs` migration + runtime/schema upgrade journal | 迁移实现；旧 Bundle upgrade/rollback 删除 |
| 卸载 | 删除 AGX-owned files/provider activation，保留远端资源 | `configs uninstall` 删除新架构 owned local state，远端默认保留 | 迁移实现；删除旧 uninstall code |
| 本地安装控制面 | Bundle schema、production pin、archive download/extract、direct runtime sidecar | 由 `configs` 官方发布和自身状态管理承载 | 删除全部 AGX local installer/Bundle/sidecar |

### 3.2 用户入口迁移表

最终命令名必须由 `configs` CLI 的正式命令合同固定；下表是本设计要求的行为，不是假定上游目前已经存在这些命令：

| 当前入口 | 目标入口/行为 | 兼容窗口 |
| --- | --- | --- |
| `agx apply --root <dir>` | 不再存在；安装由 `configs` 官方发布/安装方式完成，部署初始化由 `configs init` 完成 | 迁移版本只显示删除原因和迁移指引，不下载 Bundle |
| `agx init ...` | `configs init ...`：plan、远端 mutation、Provider/Project 激活和恢复由同一 operation journal 承载 | `agx init` 只读解析并转交，禁止自己写 Receipt/远端资源 |
| `agx config ...` | `configs config ...`：配置修订仍由 configs state owner 直接执行 | `agx config` 可作为短期 argv handoff，不建立新状态 |
| `agx status` | `configs status`：本地配置、部署资源、Provider、Evidence 和 drift 一个状态视图 | 旧命令只读转交或输出迁移状态 |
| `agx diagnose` | `configs diagnose`：统一故障阶段、证据缺口、恢复动作和安全边界 | 旧命令只读转交 |
| `agx uninstall` | `configs uninstall`：只删除新架构明确拥有的本地对象，远端默认保留 | 旧命令只允许导出旧状态，不删除新状态 |
| AGX Receipt / Bundle flags | `configs` schema、state migration 和 operation options | 只在一次性导入器中读取；不接受新 Bundle |

迁移设计不要求 `configs` 采纳 AGX 的扁平命令名。目标是单一用户入口和单一状态权威；命令分组可以由 `configs` 的 CLI contract 决定，但必须覆盖上表全部行为。

## 4. 目标架构

```text
                 upstream configs release/package
                              │
                              ▼
                    configs CLI + control-plane
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
 config revision/state   lifecycle operations     adapters
 SQLite/state store      journal + receipts       GitHub
       │                  migrations/recovery      Provider
       │                                              Multica
       │                                              Evidence
       ▼
 unified status / diagnose / upgrade / rollback / uninstall
       │
       ├── GitHub repositories + Project (external authority)
       ├── Codex/Claude client activation (external authority)
       ├── Multica Workspace/Runtime/Agent (external authority)
       └── Evidence observations (derived, freshness-bound)
```

### 4.1 分层职责

**CLI layer**

- 只解析命令合同、参数边界和输出格式；
- 所有子进程使用 direct argv，不经 shell；
- 不把 token、API key、cookie、授权头、prompt、transcript 或工具 payload 进入 state store 或日志；
- 在 mutation 前执行 deterministic plan，在 mutation 后写 operation result。

**Control-plane domain**

- `ConfigurationRevision`：配置修订、比较、选择、建立、修订、供给和客户端启动；
- `Deployment`：deployment identity、目标仓库、Project、模板版本和绑定；
- `ProviderActivation`：provider inventory、Marketplace source、ownership 和撤销记录；
- `MulticaSubject`：typed Workspace/Runtime/Agent selector 和 readback；
- `EvidenceProfile`：要求、观察、freshness、拒绝原因和 `verified` 判定；
- `Operation`：plan、mutation、阶段、补偿、恢复和人工清理边界。

**Adapter layer**

- GitHub adapter 只通过结构化 GitHub API/CLI 输出操作资源；
- Provider adapter 只调用官方版本化 CLI 的结构化 inventory/activation 接口；
- Multica adapter 只调用已批准的官方 CLI/API；
- client adapter 只负责激活和读取允许的摘要，不接管客户端数据库、session 或 transcript。

**State layer**

`configs` state store 是本地状态的唯一写入入口。至少需要以下版本化集合：

- `config_revisions`、`active_revision`；
- `deployments`、`deployment_repositories`、`projects`；
- `provider_activations`；
- `multica_subjects`；
- `evidence_profiles`、`evidence_observations`；
- `operations`、`operation_steps`、`recovery_actions`；
- `migration_runs`、`upgrade_runs`、`rollback_runs`。

外部系统仍是其资源真实状态的权威。state store 保存 URL、node/number、revision、visibility、typed IDs、digest、last-read timestamp、阶段和错误摘要等最小绑定，不复制远端正文。

### 4.2 状态判定

- `configured` 表示本地 state store 的配置和部署绑定完整；
- `drifted` 表示本地 binding 或允许的外部 readback 不匹配；
- `awaiting` 表示证据不足或等待 Agent/client first-use；
- `verified` 只表示当前 Evidence Profile 的全部必需外部证据在 freshness 窗口内匹配；
- 配置命令返回零、runtime 启动成功、数据库可读或本地 migration 完成，都不能单独产生 `verified`。

## 5. 状态迁移与所有权

### 5.1 迁移输入

一次性迁移器可读取：

- 旧 `.agx/receipt.json` 的非敏感安装和 ownership 元数据；
- 旧 AGX 记录的 Bundle/template/component binding；
- 由 operator 明确提供或通过结构化 API 重新读取的 GitHub/Project/Provider/Multica 资源标识。

迁移器不得读取或复制配置正文、客户端 session、prompt、transcript、凭据、授权头或任意未知文件内容。旧 receipt 缺失、损坏、路径漂移或无法证明 ownership 时，迁移必须停止并报告人工处理，而不是猜测归属。

### 5.2 目标所有权

| 数据 | 目标权威 | 本地保存 |
| --- | --- | --- |
| 配置修订/active revision | `configs` state store | 完整业务记录，按 schema 版本迁移 |
| GitHub repo/Project 当前状态 | GitHub | 最小 binding + 最近结构化 readback |
| Provider Marketplace/激活状态 | Provider 官方 CLI/客户端 | source、ownership、版本和结果摘要 |
| Multica Workspace/Runtime/Agent | Multica | typed IDs、readback 摘要和时间 |
| Evidence 是否满足 | `configs` evaluator + 外部观察 | profile、observations、freshness、diagnostics |
| 凭据/session/transcript/cache | 原生客户端或凭据系统 | `configs` 不保存 |
| operation/upgrade/rollback/recovery | `configs` state store | 不可变阶段记录和补偿结果 |
| 旧 AGX receipt/Bundle | 迁移输入 | 迁移 checkpoint 后删除或由 operator 另行归档 |

### 5.3 Receipt 迁移

旧 Receipt 不迁移为第二种长期 Receipt。迁移器把它转换成一次 `migration_run`、若干 deployment/component binding 和 operation history，并写入 source schema/version、输入摘要和迁移结果。新 state store 的记录必须能回答“谁创建、绑定什么、最后一次观察何时、失败在哪一步”，但不得保存旧 Receipt 中不再需要的路径或未知 payload。

## 6. 迁移阶段与复杂度

估算按一名熟悉当前 AGX 和上游 `configs` 的工程师计算；范围包含实现、测试、迁移演练和评审，不包含上游 Release 等待时间。由于上游接口尚未完成对齐，置信度为中低，最大变数是 state schema、CLI extension seam 和正式发布方式。

| 阶段 | 交付物与退出条件 | 复杂度 | 估算 |
| --- | --- | --- | --- |
| M0 前置核验与冻结 | 确认 `configs` 源码许可/集成边界、CLI extension seam、SQLite schema、官方发布流程、平台资产和可验证 `configs-v*` Release；无 Release 时只产出阻塞报告 | M | 1–2 周 |
| M1 统一 domain/state contract | 定义 config/deployment/provider/Multica/evidence/operation schema、版本迁移、redaction 和状态机；单元/fixture 通过 | L | 2–3 周 |
| M2 GitHub/Project/Provider | 迁移 repo/Project mutation、readback、ownership、Provider inventory/activation、补偿和冲突策略 | L | 2–4 周 |
| M3 Multica/Evidence | typed subject、结构化 readback、Evidence Profile/freshness/`verified` gate、拒绝和超时语义 | XL | 2–4 周 |
| M4 init/bootstrap/first-use/recovery | plan/apply、模板渲染、Bootstrap Verification、first-use contract、operation journal、可恢复部分成功 | L | 2–3 周 |
| M5 status/diagnose/upgrade/rollback/uninstall | 统一状态与诊断、迁移/升级/回滚、local ownership 清理和远端保留边界 | L | 2–3 周 |
| M6 迁移工具与切换 | 旧 receipt importer、fresh install/migration rehearsals、compat handoff、数据备份和恢复演练 | L | 1–2 周 |
| M7 删除旧控制面 | 删除 AGX installer、Bundle schema/manifest、archive download/extract、runtime sidecar、旧 evaluator/Receipt writer；旧命令不再写状态 | M | 1–2 周 |

总工程量约为 **12–20 engineer-weeks**，不是把当前 sidecar 代码换个入口即可完成的工作。M0 或任一外部 adapter contract 失败时，应停止后续删除工作；不得用临时双写掩盖缺少的正式边界。

## 7. 非目标

- 不把 `agent-systemX` 未发布或未批准的源码快照伪装成生产依赖；
- 不在没有正式 Release、checksum/provenance 和平台 smoke 证据时宣布生产可用；
- 不保留 AGX installer、Bundle 下载器、`agent-plugins` archive 解包器或 runtime sidecar 作为最终 fallback；
- 不长期维护两个 CLI、两个 SQLite、两个 Receipt 或双向同步；
- 不把 GitHub/Multica 的日常 Task 调度、daemon、遥测或工作流日志变成 `configs` 的职责；
- 不复制凭据、prompt、transcript、Session、客户端私域正文或工具 payload；
- 不因迁移自动删除用户的远端仓库、Project、未知文件或非本系统状态；
- 不在本轮设计中决定上游未承诺的命令名称、数据库内部表名或 Release asset filename；这些必须由 G0 的真实上游合同和 M1 schema contract 固定，而不是由 AGX 猜测。

## 8. 兼容与删除计划

### 8.1 迁移窗口

迁移版本提供一个只读、可重复执行的 importer/handoff：

1. 预检旧 receipt、安装根、远端绑定和 operator 提供的身份；
2. 生成迁移 plan，列出可迁移项、冲突项、无法证明 ownership 的项和回滚点；
3. 写入 `configs` migration run 和目标 state store，必要时重新执行结构化远端 readback；
4. 在 operator 明确确认后，禁用旧 AGX 写路径并创建备份摘要；
5. 验证新 `configs status/diagnose` 与迁移验收矩阵；
6. 删除旧 `.agx/receipt.json`、旧 installer-owned runtime/archive 文件和旧 AGX metadata，仅删除 receipt 能证明的对象；未知文件和远端资源保留。

Importer 不调用旧 `Apply`，不下载新的 AGX Bundle，也不把旧 archive 解包到新目录。迁移失败时保留旧输入和迁移日志，目标 state store 使用事务/阶段 checkpoint，允许重新运行；不得回写旧 Receipt 作为双写。

### 8.2 删除清单

删除必须以代码搜索、构建产物扫描和 fresh install 验证为门禁：

- `internal/install` 的 production archive download/extract、Bundle apply、旧 owned-file Receipt writer；
- `internal/bundle` 的 production Bundle schema、manifest embedding、plugin pin gate 和 sidecar descriptor；
- `internal/configs` 当前“由 AGX Receipt 校验后 spawn”的 runtime bridge；目标是 `configs` 自身直接拥有 state/CLI；
- AGX CLI 的 `apply`、`--bundle` 和旧 status/drift evaluator 写路径；
- 只服务旧 installer 的 receipt schema、staging/commit、archive fixture 和 release packaging；
- README、合同、CI 和发布说明中对旧 AGX installer/Bundle/sidecar 的生产承诺。

删除后，`agx` 若仍存在，只能是短期兼容 handoff 或迁移诊断入口；它不能创建新安装、下载 Bundle、写旧 Receipt、拥有 configs state 或执行远端 mutation。最终是否保留一个极薄的 `agx` binary wrapper，取决于发布方的兼容承诺；它不改变 `configs` 为唯一运行时的结论。

## 9. 安全设计

1. **发布供应链**：生产 runtime 必须来自真实、版本固定、可验证的上游 Release/package；资产、内容、source commit/tag、平台和 checksum 必须互相绑定。没有 G0 证据就停止生产切换。
2. **状态隔离**：state store 路径由 `configs` 明确确定并限制在 operator 选定的 installation/workspace 范围；禁止因命令参数或环境变量静默读取另一个项目的数据库。
3. **进程边界**：所有官方 CLI/client 调用使用 direct argv、显式工作目录、受控环境和结构化输出；禁止 shell 拼接、`cmd /c`、`sh -c` 和把原始命令 payload 写日志。
4. **凭据边界**：使用 GitHub/Provider/Multica 官方凭据存储或已有登录会话；state、logs、support bundle 和 migration artifacts 只保存 opaque reference、版本、状态和错误摘要。
5. **远端所有权**：同名仓库、Project、Marketplace source 或 selector 冲突时 fail closed；没有 creation receipt 或 typed ownership 的对象不自动修改/删除。
6. **证据边界**：本地 migration、runtime 启动、零退出码和完整文件树只能是 `configured` 或操作成功信号，不能成为外部 `verified` 证据。
7. **恢复安全**：每一步 mutation 记录阶段、request identity、readback 和补偿结果；不确定结果报告 `inconclusive/needs_resume`，不猜测远端是否已变更。
8. **删除安全**：删除只依据新 state store 中的明确 ownership 和 digest；未知文件、非系统状态、远端仓库和 Project 默认保留。

## 10. 验收门禁

### Gate G0：上游发布与接口前置

- 真实上游存在与目标平台匹配的 `configs-v*` Release 或官方安装包；
- 发布流程给出 source commit/tag、平台/架构资产、checksum 和可复核 provenance；
- `configs` CLI 的扩展点、SQLite/state schema、数据库隔离和退出码/信号合同已由上游文档或源码确认；
- 至少 Windows 11 x64 与 Ubuntu 24.04 x64 完成下载/安装/启动 smoke；其他平台在有证据前只能标为 preview；
- 在本门禁通过前，生产 manifest 不变，不填写猜测的 tag/hash/URL。

### Gate G1：状态单一权威

- 全部配置修订、deployment binding、Provider/Multica/Evidence、operation、upgrade/rollback/recovery 记录可在 `configs` state store 重建；
- 新路径不创建 `.agx/receipt.json`，不读写 AGX Bundle，不执行 archive extraction；
- 任意阶段失败可重试或明确报告人工清理，不能产生不可见双写。

### Gate G2：能力等价

- GitHub 仓库/Project 创建、readback、visibility、revision、冲突和保留规则与现有合同一致；
- Codex/Claude Provider activation 和 ownership 规则一致；
- Multica typed selectors、readback、超时和失败阶段可验证；
- Evidence Profile 的 freshness、拒绝、`awaiting`、`effective`/`verified` 边界一致；
- init、activation、bootstrap、first-use、recovery、status、diagnose、upgrade、rollback、uninstall 逐项通过 capability matrix。

### Gate G3：安全与隐私

- shell 注入、路径逃逸、symlink/junction、伪造 Receipt、digest mismatch、同名远端资源和不确定 mutation 测试 fail closed；
- receipt/state/log/JSON/support bundle 不包含凭据、prompt、transcript、Session、私域正文或工具 payload；
- `verified` 没有任何只依赖本地运行成功的路径。

### Gate G4：迁移与回滚

- fresh `configs` deployment、旧 AGX installation migration、部分成功重试、未知文件保留和远端资源保留均有可重复演练；
- 迁移前后配置 active revision、deployment bindings、Provider ownership 和 Evidence 状态可对账；
- 失败 migration 可恢复到旧输入，不需要恢复旧 AGX installer；
- rollback 只回滚新架构的 schema/release/operation，不重新引入旧 Bundle/sidecar。

### Gate G5：删除与发布

- 代码、二进制、CI、文档和测试 fixture 中不存在旧 installer/Bundle/sidecar 的生产路径；
- `agx apply --bundle` 不再下载或安装任何资产；旧命令只能输出迁移提示或只读 handoff；
- 新 `configs` package/release 的升级、回滚、卸载、状态和诊断 smoke 通过；
- 迁移完成后，支持包和 status 输出只引用 `configs` state/operation/evidence，不引用旧 AGX Receipt。

## 11. 可观测性与运维要求

每次 migration、init、activation、upgrade、rollback、uninstall 必须有结构化 operation ID、阶段、开始/结束时间、结果、外部 request identity（若可安全保存）、readback 状态和下一步。日志只输出 allowlisted summaries。状态输出必须区分：

- 本地 state store 是否可读；
- 配置 active revision 是否匹配；
- GitHub/Project/Provider/Multica readback 是否匹配或 inconclusive；
- Evidence Profile 是否满足及缺口；
- operation 是否需要 resume/manual cleanup；
- 新架构是否已完成迁移和旧文件删除。

任何“不确定”都不得降级为“未发生”，也不得升级为 `verified`。迁移器要保存可重放的输入摘要和 schema version，但不保存敏感原文。

## 12. 决策与后续动作

本设计批准后，实施顺序固定为：

1. 先完成 G0 的上游 Release、CLI seam、state schema 和平台证据核验；
2. 以 M1 的 state/domain contract 为基线，按 M2–M5 迁移能力并建立 parity tests；
3. 在 M6 完成旧 receipt importer 和双环境演练；
4. 只有 G1–G4 通过后执行 M7 删除旧 installer/Bundle/sidecar；
5. 用 G5 的 fresh install、migration、upgrade/rollback、status/diagnose/uninstall evidence 发布切换说明。

G0 未通过时可以继续写设计、schema contract、测试夹具和 adapter 接口，但不得修改生产 manifest，不得宣称 `configs` production-ready，不得用 synthetic fixture 替代真实上游发布证据。
