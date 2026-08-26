---
title: Agent System X Project Phase 1 薄集成设计
status: draft
date: 2026-08-26
owner: 项目负责人
upstream: https://github.com/2233admin/agent-systemX
---

# Agent System X Project Phase 1 薄集成设计

## TL;DR

项目品牌统一为 **Agent System X Project**，当前仓库继续使用 `2233admin/agx`。本轮不做上游源码搬迁、不重排现有目录、不重写 CLI，也不把两套状态库合并。

Phase 1 只在现有 AGX 上增加一个受完整性保护的 `configs` runtime 集成：`agx apply` 安装并绑定上游发布的 `configs` 二进制，`agx config ...` 安全转发到已绑定 runtime，`agx status` 显示 runtime 状态。AGX 现有的远端仓库、Project、Provider、Multica、Evidence、Receipt、诊断、恢复、升级和卸载能力保持不变。

这是完整合并目标的低工作量第一步。后续是否把上游源码和 CI 纳入同仓，另行决策，不作为本轮前置条件。

## 决策卡

| 项目 | 决定 |
| --- | --- |
| Driver | 在保留 AGX 全部现有能力的前提下，低成本接入上游 `configs` |
| Approver | 项目负责人 |
| Contributors | AGX 实现维护者、agent-systemX 上游维护者 |
| Informed | Release/CI 维护者和后续接手者 |
| Lifecycle | 决策前设计，批准后进入实施规划 |
| Impact | 增加一个受管 runtime、最小 Receipt 字段和 `agx config` 路由 |
| Outcome | 一个 `agx` 用户入口，旧部署流程不变，上游配置能力可调用 |

## 现状与问题

当前 AGX 是 Go 部署与生命周期 CLI，已有以下能力：

- 固定 Bundle 的安装、校验、幂等和卸载；
- `agent-control` / `agent-contracts` 远端仓库和 GitHub Project 初始化；
- Codex/Claude Provider 激活；
- Multica 和 Evidence Profile；
- Receipt、status、diagnose、恢复、升级和回滚边界。

上游 `agent-systemX` 的 `packages/control-plane` 已提供独立的 TypeScript/Bun `configs` CLI，负责配置查看、比较、选择、建立、修订、供给和客户端启动。上游 `release-configs.yml` 已定义跨平台 `configs` 二进制的构建、测试、版本注入、SHA-256 清单和 Release 发布流程。

直接把上游源码并入 AGX 会触发目录迁移、双栈构建、命令冲突、状态合同和跨平台打包等一系列高成本变化。Phase 1 先把两个系统的稳定边界定义为一个发布 artifact 接口，避免在没有实际使用证据前进行大规模合并。

## 目标

1. 对外品牌使用 Agent System X Project。
2. 保留当前仓库 `2233admin/agx`，不做仓名迁移。
3. 保留 AGX 当前所有部署、远端资源、Provider、Multica、Evidence 和生命周期能力。
4. 通过固定版本和 SHA-256 digest 安全交付上游 `configs` runtime。
5. 让用户通过 `agx config ...` 使用上游 `configs` 能力。
6. 让 Receipt、status 和 uninstall 正确表达 runtime 的所有权和状态。
7. 不要求用户单独安装、升级或管理第二个公开 CLI。
8. 只增加一条可验证的集成路径，不提前实现完整同仓同步目标。

## 非目标

- 不把 `agent-systemX` 源码复制或搬迁进 AGX。
- 不新增 `upstream` 双向同步流程。
- 不修改现有 `internal` 目录结构，不重命名当前 AGX 包。
- 不把现有扁平命令改为 `agx deploy ...` 分域命令。
- 不重写上游 TypeScript/Bun 控制面。
- 不合并 AGX Receipt 与 `configs` SQLite。
- 不重构 GitHub 仓库、Project、Provider、Multica、Evidence 或远端部署流程。
- 不新增配置推荐、任务调度、daemon、遥测或跨客户端等价层。
- 不通过未固定的上游 `main`、本地 checkout 或可变 URL 获取 runtime。
- 不复制凭据、prompt、transcript、Session、私域原文或工具 payload。

## 方案与权衡

| 方案 | 复杂度 | 保留能力 | 主要风险 | 结论 |
| --- | --- | --- | --- | --- |
| 现有 AGX + 受管 `configs` sidecar + `agx config` 转发 | 低到中 | 两边能力都保留 | 仍有两个内部 runtime，需要版本绑定 | **Phase 1 采用** |
| 同仓纳入上游源码并统一双栈发布 | 中高 | 两边能力都保留 | 目录、CI、发布和同步冲突大 | 后续候选 |
| 重写上游 `configs` 为 Go | 高 | 可变成单 runtime | 行为回归和长期维护成本高 | 不采用 |
| 继续维持两套独立 CLI | 低 | 两边能力都保留 | 用户入口和版本管理分裂 | 不采用 |

## Phase 1 架构

```text
agent-systemX Release
        │
        │ 固定 version + source commit + SHA-256
        ▼
AGX Bundle / Receipt
        │
        ├── 当前 AGX Go CLI
        │   ├── apply / init / status / diagnose / uninstall
        │   ├── repository / project / provider / multica / evidence
        │   └── recovery / receipt
        │
        └── 受管 configs runtime
                ▲
                │ 直接 argv 转发
                └── agx config ...
```

### 用户入口

Phase 1 保留当前 AGX 的既有命令语义：

```text
agx apply --root <directory>
agx init ...
agx status --root <directory>
agx diagnose --root <directory>
agx uninstall --root <directory>
```

新增：

```text
agx config list
agx config show <revision-id>
agx config compare <revision-id> <revision-id> [...]
agx config use <revision-id>
agx config status
agx config switch <revision-id>
agx config establish ...
agx config revise ...
agx config supply ...
```

`agx config` 不重新解释上游业务参数，只负责：检查 runtime binding、校验受管二进制、设置受控环境、直接启动子进程、透传标准输入输出和返回类型化退出结果。

### Runtime binding

AGX 的 Bundle manifest 增加受限的 `configs_runtime` 描述：

- `runtime_id`；
- `runtime_version`；
- `source_repository`；
- `source_commit` 或上游 release tag；
- 平台和架构；
- artifact URL；
- artifact SHA-256；
- 解包后内容 SHA-256；
- 安装相对路径；
- 合同/schema 版本。

Receipt 只保存上述非敏感绑定及安装结果。不得保存 runtime 的配置正文或客户端运行内容。

### 数据所有权

| 数据 | 权威所有者 | Phase 1 行为 |
| --- | --- | --- |
| Installation、Bundle、远端仓库、Project、Provider、Multica、Evidence、Receipt | AGX | 保持现有实现 |
| `configs` 配置修订和配置状态 | `configs` runtime | 通过子进程访问，不由 AGX 直接写入 |
| prompt、transcript、Session、凭据和缓存 | 原生客户端 | AGX 不读取、不复制、不持久化 |

`configs` 的数据库路径必须通过受控环境或显式 runtime 参数绑定到安装范围，不能因为 `agx config` 调用而静默读取另一个用户或项目的状态。若当前上游 runtime 不支持该隔离方式，Phase 1 在适配前停止，不通过猜测路径绕过边界。

## 操作流程

### 安装

`agx apply` 的现有流程不变，并追加：

1. 校验生产 Bundle 和 `configs_runtime` descriptor；
2. 下载对应平台 artifact；
3. 校验压缩包和解包内容 digest；
4. 安全解包到 AGX-owned 安装目录；
5. 写入 runtime binding Receipt；
6. 任一步骤失败则不报告安装完成，也不运行未校验的 runtime。

重复 apply 同一版本必须幂等。不同版本不得覆盖既有受管 runtime，除非现有升级路径明确批准并完成新 Receipt 写入。

### 配置命令

每次 `agx config ...`：

1. 读取当前 Installation Receipt；
2. 校验 runtime 文件存在、路径归属、版本和 digest；
3. 校验客户端参数边界；
4. 使用直接 argv 启动受管 runtime；
5. 透传 stdout、stderr、stdin、退出码和取消信号；
6. 只把 allowlist 后的阶段、退出码和错误摘要用于诊断。

runtime 不存在、digest 不匹配、版本不兼容、配置状态不可读时，命令 fail closed。

### 状态与卸载

`agx status` 增加：

- `configs` runtime 是否已安装；
- runtime version；
- source commit/tag；
- artifact/content digest 是否匹配；
- 绑定状态和下一步。

这类信息不等于配置已生效、客户端已启动或外部 Evidence 已 verified。

`agx uninstall` 只删除 Receipt 能证明由 AGX 新增的 runtime 文件和 Provider 激活；保留远端仓库、Project、未知本地文件以及非 AGX 所有的 `configs` 状态。若配置数据库位于安装目录内，必须有明确 ownership receipt 才能删除。

## 失败与安全边界

- 上游 Release 不存在或没有目标平台 artifact：停止发布或安装，不回退到源码、`main` 或本地 checkout。
- artifact digest 不匹配：拒绝解包或执行。
- runtime 子进程退出：保留退出码和错误阶段，不把它解释为部署成功。
- runtime 被替换、移动、权限异常或路径逃逸：报告 drift，拒绝执行。
- AGX 远端 mutation 返回不确定结果：继续使用现有 `needs_resume` / `needs_manual_cleanup`，不因 runtime 集成改变补偿策略。
- 配置失败、Provider 失败、GitHub 失败和 Multica 失败在 status/diagnose 中分开表达。
- `verified` 仍只来自匹配 Evidence Profile 的外部证据；runtime 安装和 `configs` 命令退出码为零都不能提升状态。
- 子进程参数不得经过 shell 拼接；日志和 Receipt 使用 allowlist。

## 实施切片

### Slice 1：发布输入

- 扩展 Bundle schema，加入 `configs_runtime` descriptor。
- 固定一个上游 `agent-systemX` release artifact。
- 若上游没有可用的正式 Release，先停止本切片，不自行消费 mutable source。

### Slice 2：本地生命周期

- 在现有 install/apply 流程安装、校验和记录 runtime。
- 在现有 Receipt 中增加最小 binding。
- 将 runtime 纳入 drift、status 和 uninstall。

### Slice 3：统一外壳

- 增加 `agx config` 路由和直接进程转发。
- 不改变现有 AGX 扁平部署命令。
- 统一退出码、signal 和错误摘要。

### Slice 4：验证与文档

- 增加 fresh install、重复安装、digest 失败、runtime 缺失、转发和卸载测试。
- 运行 `go test ./...`。
- 对受管 `configs` runtime 运行上游规定的 typecheck/test/smoke；若只拿到 Release artifact，则至少运行 `agx config list` fresh-state smoke。
- 更新 README、Bundle contract 和 release notes。

## 触达资产

| asset_id | relation | change_or_usage | scope | risk | verify | rollback |
| --- | --- | --- | --- | --- | --- | --- |
| `cmd/agx` | 用户入口 | 增加 `config` 子命令转发 | CLI | 参数/退出码错误 | command matrix、子进程 smoke | 回滚路由提交 |
| `internal/cli` | AGX 命令分派 | 保留旧部署命令，增加 runtime 路由 | CLI | 旧行为回归 | `go test ./...`、golden output | 回滚 CLI 变更 |
| `internal/install` | 安装生命周期 | 安装并校验 configs artifact | 本地安装目录 | 供应链、路径逃逸 | digest、权限、重复安装测试 | 删除新增 owned runtime |
| `internal/bundle` | 安装输入 | 扩展 Bundle schema 和生产 pin | manifest | schema 漂移 | schema/pin tests | 回退 Bundle descriptor |
| `internal/metadatafile` | Receipt 持久化 | 增加最小 runtime binding | Receipt | 敏感字段或兼容性回归 | allowlist、旧 receipt 测试 | 旧 receipt 只读兼容 |
| `internal/provider` | Provider 生命周期 | 保持现有激活与卸载 | Provider | 误删既有 source | ownership tests | 只撤销 AGX-owned 对象 |
| `internal/activation` | 远端部署与 Evidence | 保持既有流程，仅补 runtime 绑定 | GitHub/Project/Multica | 跨域状态混淆 | 既有 activation tests + integration | 回滚绑定逻辑 |
| `README.md` | 用户说明 | 改品牌并增加 `agx config` 使用 | 文档 | 说明与行为漂移 | 命令 smoke 对照 | 回滚文档提交 |
| `release.manifest` | 发行合同 | 绑定 AGX 和 configs runtime | Release | 版本错配 | source/digest 校验 | 拒绝发布 |

## 验收标准

1. 现有 `agx apply/init/status/diagnose/uninstall` 行为和远端部署能力继续通过原有测试。
2. fresh `agx apply` 能安装、校验并记录匹配的 `configs` runtime。
3. `agx config list` 能从全新状态目录启动受管 runtime。
4. `agx config` 的 stdout、stderr、退出码、stdin 和取消信号边界可验证。
5. runtime 缺失、路径漂移、版本不匹配或 digest 错误时 fail closed。
6. 重复 apply 不重复下载或破坏既有安装；未知 runtime 不会覆盖受管版本。
7. `agx status` 能显示 runtime 绑定和完整性状态，但不误报 `verified`。
8. `agx uninstall` 只清理 AGX-owned runtime，不删除远端仓库、Project、未知文件或非 AGX 状态。
9. 不把凭据、prompt、transcript、Session、私域正文或工具 payload 写入 Receipt、日志或支持包。
10. `go test ./...` 和受管 runtime 的可执行 smoke 通过。

## 风险与开放问题

### 已接受风险

- 同一用户入口内部仍有 Go 与 Bun 两个 runtime；这是为降低本轮工作量接受的成本。
- `configs` release artifact 需要上游先提供稳定、可验证的发布资产；没有 artifact 时本轮安装集成不能伪造完成。
- 旧 AGX CLI 暂不改成 `deploy` 命名，命令体系短期不完全统一。

### 开放问题

- 上游 `configs` 的默认 SQLite 路径需要确认是否支持 AGX 安装隔离；否则必须在 Phase 1 增加受控路径参数或延后该能力。
- `configs` runtime 采用安装目录 sidecar 还是平台特定嵌入方式，先选 sidecar；只有 sidecar 在某平台无法满足完整性或分发要求时才重新评估嵌入。
- 上游 Plugin/合同资产本轮继续使用现有 AGX Bundle；是否改为直接消费 agent-systemX 的统一资产包，留到后续同仓同步设计。

## Action items

| Action | Owner | Gate |
| --- | --- | --- |
| 确认上游可用 Release artifact 和目标平台 | 同步维护者 | Slice 1 前 |
| 扩展 Bundle schema 与 production pin | AGX 实现维护者 | Slice 1 |
| 增加 runtime 安装、Receipt 和 drift 逻辑 | AGX 实现维护者 | Slice 2 |
| 增加 `agx config` 转发和错误边界 | CLI 维护者 | Slice 3 |
| 完成安装/转发/卸载 smoke | 验收维护者 | Slice 4 |
| 更新品牌、README 和合同 | 文档维护者 | Slice 4 |

## 依据

- 当前 AGX：`README.md`、`CONTEXT.md`、`docs/spec/PRD.md`、`docs/spec/SDD.md`、`internal/cli/cli.go`。
- 上游仓库：`https://github.com/2233admin/agent-systemX`。
- 上游产品规格：`https://raw.githubusercontent.com/2233admin/agent-systemX/main/_bmad-output/specs/spec-agent-system/SPEC.md`。
- 上游 Epic 和命令范围：`https://raw.githubusercontent.com/2233admin/agent-systemX/main/_bmad-output/planning-artifacts/epics.md`。
- 上游发布流程：`https://raw.githubusercontent.com/2233admin/agent-systemX/main/.github/workflows/release-configs.yml`。
- 上游默认状态路径：`https://raw.githubusercontent.com/2233admin/agent-systemX/main/packages/control-plane/src/cli/db-path.ts`。
