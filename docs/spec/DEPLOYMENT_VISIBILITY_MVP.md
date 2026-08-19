# AGX 部署可见性 MVP

状态：Project 部署与首个真实可见闭环已交付；Evidence Profile 真值层正在分阶段接入
日期：2026-08-18

## 要解决的问题

AGX 现在会在 `init --apply` 中创建、配置、关联并结构化回读部署专属 GitHub Project；初始化计划、恢复回执、first-use contract、`status` 与 `diagnose` 都能显示这个资源。用户仍需在新的 Agent Session 中执行版本化 first-use contract 来产生 Issue、Project item、分支/PR 与验证结果，但不再依靠一句未建模的自由文本创建看板。

本 MVP 只解决三个可观察结果：

1. GitHub 上存在一个用户可打开的 Project 看板，并与部署控制仓关联；
2. 模板已经作为远端仓库的初始提交部署，关键入口完整且自身验证通过；
3. 一个真实 Agent 能按模板完成一次最小写入闭环，并返回 Issue、Project item、分支/PR 和验证结果。

Project 可见性不依赖 KA、知识内容或 Agent Plugin 是否已经在新 Session 中生效。AGX 负责创建和回读 Project；Agent 只负责真实使用 smoke。

Project、模板与 first-use smoke 是 Evidence Profile 的外部 observation 来源，不是 `verified` 的快捷方式。`github-delivery/v1` 只有在完整 GitHub requirements 都与当前 installation/deployment/subject 绑定、结果匹配且仍在 freshness 窗口内时才可达到 `verified`；`multica-execution/v1` 在同一 GitHub 基线之外还要求 Workspace、Runtime、Agent 与完成的 Task 或 Run。Multica 是可选扩展，且不属于 AGX 0.1 的发布阻塞项。当前 evaluator 在 collector 尚未接入时应如实返回缺项或 `awaiting_verification`，不得从 Project 存在、Runtime online、PR opened、smoke effective 或 Agent 自报完成推断成功。

## 不在本 MVP 内

- 日常任务创建、分配、调度和进度管理；
- 自动删除 GitHub Project 或部署仓；
- 从任意本地目录覆盖既有远端仓；
- 自动迁移用户修改过的模板；
- 把本地完整性或一次 Agent smoke 直接标记为 `verified`；
- 调整五个上游仓库的最终组织方式。

## Baseline

| 编号 | 当前行为 | 证据 | 结论 |
|---|---|---|---|
| B01 | `agx apply` 安装固定 Release 的 `agent-plugins` | `internal/install/install.go` | 已有主干 |
| B02 | `agx init --apply` 创建 `agent-control` 和 `agent-contracts` 仓 | `internal/activation/activation.go` | 已有主干 |
| B03 | 仓库初始提交包含 README、AGENTS、Issue Forms、workflow 和验证工具 | `internal/bootstrap/templates/` | 模板内容存在 |
| B04 | 初始化计划、v3/v4 回执与状态输出包含 Project create/link/readback | `internal/activation/activation.go`, `internal/project/` | 已有主干 |
| B05 | provider 只返回自由文本 first-use action | `internal/provider/provider.go` | 没有结构化 smoke 合同 |
| B06 | 已完成一次真实 Project + Agent first-write 可见闭环；后续发布仍须按精确版本重复取证 | GitHub #42 / PR #48 交付证据 | 单次证据不等于持续 verified |

## Target flow

```text
T01 agx setup
  -> 检查 gh 身份、Project 权限、仓库目标、Agent Inventory
  -> 显示 Project、repository、profile、visibility 和写入顺序

T02 agx init --apply
  -> 创建模板仓并回读初始提交
  -> 创建 GitHub Project
  -> 设置 Project 可见性
  -> 将 Project 链接到控制仓
  -> 回读 Project 和 repository.projectsV2
  -> 激活 Agent
  -> 持久化非敏感恢复回执

T03 新 Agent Session
  -> 读取结构化 first-use contract
  -> 创建 Bootstrap Verification Issue
  -> 将 Issue 加入 Project
  -> 从分支更新模板指定文件并打开 PR
  -> 运行模板验证
  -> 返回 Project / Issue / PR URL 和验证结果

T04 agx status / diagnose
  -> 显示 Project URL、模板仓 URL、Agent 配置态和 smoke evidence
  -> 没有外部验收证据时仍保持 configured/awaiting
  -> 远端回读达到 deadline 或被取消时返回 AGX-STATUS-INCONCLUSIVE，不把部分观察误判为 drift，也不执行写入
```

## D01 — GitHub Project 是部署资源

### 计划

初始化计划新增一个 Project 条目，至少显示：

- owner；
- title；
- visibility；
- 目标控制仓；
- action：`create`、`verify` 或 `conflict`；
- mutation 顺序和保留策略。

默认标题应稳定、可辨认并包含部署身份，例如 `<control-repo> deployment`。同名 Project 不能仅凭标题被 AGX 自动接管；只有 receipt 中的 Project node ID/number 与结构化回读匹配时才能执行 `verify`。

### Preflight

- `gh` 可用且身份与目标 owner 相容；
- token 具备 GitHub Projects 所需的 `project` scope；
- 能以 JSON 读取 owner 的 Project 列表；
- 所有 repository、Project 和 provider 检查在第一次写入前完成；
- 缺少 scope 时不尝试自动扩大权限，只输出精确修复命令：`gh auth refresh -s project`。

GitHub CLI 官方说明 `gh project` 需要 `project` scope，并提供 `project create`、`view`、`link` 和 JSON 输出：[gh project command](https://cli.github.com/manual/gh_project)、[gh project create command](https://cli.github.com/manual/gh_project_create)、[gh project link command](https://cli.github.com/manual/gh_project_link)。

### Apply 与回读

AGX 通过参数数组调用官方 CLI，不拼接 Shell 命令：

```text
gh project create --owner <owner> --title <title> --format json
gh project edit <number> --owner <owner> --visibility <PUBLIC|PRIVATE> --format json
gh project link <number> --owner <owner> --repo <control-repo>
gh project view <number> --owner <owner> --format json
gh repo view <owner>/<control-repo> --json projectsV2
```

`gh repo view` 当前支持读取 `projectsV2` 字段，可用于确认关联关系：[gh repo view](https://cli.github.com/manual/gh_repo_view)。

Project receipt 至少保存：owner、number、node ID、URL、title、visibility、linked repository、creation/readback 状态和 installation ID。不得保存 token、CLI 原始输出或认证路径。

### 恢复与卸载

- 每个外部 mutation 后立即回读并持久化 receipt；
- create 返回不确定结果时，按 receipt marker、owner 和结构化列表重新发现，不盲目重建；
- `agx uninstall` 默认保留 Project 和远端仓，只报告保留 URL；
- 删除 Project 必须是以后单独、显式的破坏性操作。

## D02 — 模板部署必须证明可用

仓库创建成功不能只证明“有一个 commit”。初始化回读必须同时确认：

- 默认分支和初始 commit 与 receipt 匹配；
- README、AGENTS、authority map、Issue Forms、workflow 和 `tools/validate.py` 等模板关键入口存在；
- Issues 功能已启用；
- 控制仓已出现在 Project 的 repository link 中；
- canonical template digest 与 Bundle/AGX 二进制匹配。

在发布 Gate 中，对渲染后的模板执行其真实验证入口。`agent-control` 和 `agent-contracts` 当前都提供 `python tools/validate.py`；测试必须在 Windows 11 和 Ubuntu 24.04 上运行。

状态语义：

- 文件与远端 commit 完整：`configured`；
- Project 可见并正确关联：`initialized` 的外部资源证据；
- Agent 能按模板真实写入：`effective` evidence；
- 这些状态都不能单独产生保留的 `verified`。

## D03 — Agent 模板写入 smoke

first-use 不再只是一个自然语言字符串，而是版本化结构化合同，至少包含：

```json
{
  "schema_version": "agx.first-use/v1",
  "installation_id": "...",
  "project_url": "...",
  "control_repository_url": "...",
  "contracts_repository_url": "...",
  "profile": "...",
  "objective": "complete bootstrap verification",
  "required_outputs": ["issue_url", "project_item", "pull_request_url", "validation_result"],
  "cleanup": "operator-owned"
}
```

真实 smoke 的最小行为：

1. Agent 打开控制仓的 README、AGENTS 和 authority map；
2. 按模板字段创建一个有界的 `Bootstrap Verification` Issue；
3. 将该 Issue 加入部署 Project；
4. 创建分支，把 `work/current.md` 更新为该 Issue 的明确恢复指针；
5. 运行 `python tools/validate.py`；
6. 打开 PR，不自动合并；
7. 返回 Project、Issue、PR URL、命令和结果摘要。

该 smoke 证明的是 Agent 能读取模板、遵守模板、写入 GitHub 并交付可审查结果。它不是日常任务调度，也不自动代表业务验收。

## 验收标准

### AC1 — 看得见

全新 owner 下执行一次明确确认后的 `agx init --apply`，用户无需启动 Agent 即可打开输出的 Project URL。Project visibility 与用户选择一致，并链接到控制仓。

### AC2 — 模板真实存在

两个目标仓的默认分支、初始 commit、关键模板文件和 canonical digest 与 plan/receipt 一致；同名仓或不匹配 Project 在写入前停止。

### AC3 — Agent 写得进去

在新的 Agent Session 中执行 first-use contract 后，GitHub 上存在符合模板字段的 Bootstrap Verification Issue、对应 Project item 和未合并 PR；模板验证命令成功。

### AC4 — 可恢复

在仓库创建、Project 创建、Project link 和 provider activation 任一步骤中断后，原命令重跑通过结构化回读继续，不能重复创建已确认资源。

### AC5 — 可诊断

`agx status` / `diagnose` 输出 Project URL、repository URL、template digest、provider/profile、缺失步骤和精确下一步。远端回读 deadline/cancellation 必须返回稳定的 `AGX-STATUS-INCONCLUSIVE` 软件错误，提示远端状态可能已变化并重新运行 `status` / `diagnose`；不得把部分观察报告为 drift，且该路径不得写入。用户不需要读取 `.agx` 文件或原始日志。

### AC6 — 权限和凭据安全

缺少 `project` scope、仓库权限或 Agent 能力时在 mutation 前失败；配置、plan、receipt、日志、fixture 和 support output 不含凭据。

### AC7 — 不冒充 verified

Project、模板和 Agent smoke 均成功时，最高只能记录对应的 initialized/configured/effective evidence。没有匹配的外部验收证据时不得输出 `verified`。

## 当前实现证据

- `internal/project` 已实现 Project scope/collision preflight、create/edit/link、结构化 readback 和 mutation journal；
- `internal/repository` 已把 Issues 开关与远端 HEAD 必需模板路径纳入 readback；
- initialization receipt 已升级为 v4；v2 可迁移到 v3，v3 继续只读兼容，只有显式 Evidence Profile 的新初始化才持久化 v4 deployment/subject binding；
- `agx.first-use/v1` 已绑定 Project、两个仓库、Issue/PR 标题、marker、branch、验证命令、六步 action 和四项 required output；
- `status` / `diagnose` 已能显示 Project、仓库/template digest 与 `awaiting` / `effective` smoke evidence，并在 repository、Project、provider 或 smoke 回读被 deadline/cancellation 中断时返回 `AGX-STATUS-INCONCLUSIVE`；
- 单元与隔离 adapter 测试覆盖 Project create/link 命令报错但远端已落地后的无重复恢复。

尚未关闭的 Gate：把 GitHub readback 转成当前 `github-delivery/v1` 的完整 typed observations，并在每个精确发布版本上重复 Windows 11 / Ubuntu 24.04 模板验证。可选 Multica collector 另票实现；collector 或必需 observation 缺失时保持 `awaiting_verification`，结果失败时进入 `blocked_outcome`，证据过期时进入 `blocked_freshness`，输入或能力在采集前无效时进入 `blocked_preflight`，不能弱化 Profile。任一 Gate 未取得匹配外部证据时都不得声称 `verified`。

## 后续优先级

### P1 — 仓库功能标记

为上游来源和部署仓定义机器可读的 `repository-role`：capability source、control state、contract specification、assembly source、decision engine。README、Bundle provenance 和诊断输出使用同一角色词汇，但 AGX 不能把固定仓库名当领域模型。

### P2 — 模板 overlay 与自定义部署

允许用户在新部署时提供本地 overlay，但必须是声明式、可预演、按目标仓分区的文件集合：

- 模板声明允许覆盖/新增的路径；
- plan 显示每个文件的目标、digest、冲突和 ownership；
- 默认拒绝 `.git`、凭据、绝对路径、symlink/junction、provider cache 和未知可执行 hook；
- 只向新建仓库提交 overlay；已有用户仓需要单独 migration/PR 合同；
- Agent 通过同一模板入口读取这些个性化内容，AGX 不把本地私有状态误当公共知识。

P1/P2 只有在 AC1–AC7 的真实 GitHub 和 Agent smoke 闭环通过后再进入实现。
