# AGXCLI

<img src="assets/oc/agx-oc-github-banner-16x9.png" width="100%" alt="AGXCLI 黑白 Macintosh CRT 猫娘协调员，置于部署与验收诊断界面中。">

AGX 的猫娘协调员对应安装、计划、验收和回执；她是项目身份，不代表目标环境已通过 `verified`。其余画幅与 GitHub 文档落点见 [OC kit](assets/oc/README.md)。

AGXCLI (`agx`) 是小型部署与生命周期 CLI：它安装固定版本的 `agent-plugins`，再从内置的版本化模板创建部署专属的 `agent-control`、`agent-contracts` GitHub 仓库及关联 Project，激活 Codex/Claude，并用本地回执管理恢复、状态、诊断和安全卸载。

> 当前状态：本地 Bundle 部署闭环和 Codex/Claude 初始化阶段已实现。Multica 编排不属于当前发布阻塞项。

## 目标体验

用户下载一个独立可执行文件，先安装插件发行包，再预演初始化：

```text
agx apply --root D:\agx\installations\default
agx init --guided --root D:\agx\installations\default
agx init --root D:\agx\installations\default --github-owner octo-lab --provider codex --profile full
agx init --root D:\agx\installations\default --github-owner octo-lab --provider codex --profile full --apply
```

`--guided` 先只读发现当前 `gh` 身份、Codex/Claude CLI 和 Marketplace source，再让用户确认 owner、provider、profile、visibility 与两个部署仓名。确认后执行的只读 plan preflight 才检查 Projects `project` scope，并打印确定性 plan 和可复制的显式 `agx init ... --apply` 命令；只有执行带 `--apply` 的显式命令才会产生写入。AGX 默认创建私有的 `octo-lab/agent-control`、`octo-lab/agent-contracts` 和一个 receipt-bound GitHub Project；仓库、Project visibility、Project link 每次 mutation 后都持久化恢复回执，然后才激活选定能力。初始化完成仍不等于外部验收完成；`verified` 是保留状态。

## 四仓部署速查

AGX 交付时用户会看到四类仓库，但它们不是同一层东西：

| 仓库 | 谁拥有 | 部署时怎么用 |
| --- | --- | --- |
| `2233admin/agx` | AGX 当前分发方 | 构建并发布 `agx` CLI；用户下载它来执行 `apply`、`init`、`status`、`uninstall`。 |
| `zaurakworks/agent-plugins` | 上游 Plugin 源 | AGX 只从固定 Release artifact 安装这个源；Codex/Claude 的 Marketplace 都指向它的安装副本。 |
| `<owner>/agent-control` | 用户部署拥有者 | `agx init --apply` 从 AGX 内置 `agent-control/v1` 模板创建，保存该部署的控制状态与工作入口。 |
| `<owner>/agent-contracts` | 用户部署拥有者 | `agx init --apply` 从 AGX 内置 `agent-contracts/v1` 模板创建，保存 GitHub Issue 合同表单、schema、样例和回执工具。 |

从零部署顺序是固定的：

```powershell
agx apply --root D:\agx\installations\default
agx init --guided --root D:\agx\installations\default
agx init --root D:\agx\installations\default --github-owner octo-lab --provider <guided-recommendation> --profile github --apply
```

第二条命令必须先看计划：它会列出目标 owner、两个仓库、Project title/link、visibility、模板版本与 digest、Provider Marketplace/Plugin 动作和同名资源冲突行为，并根据无冲突 provider 给出推荐。第三条命令才创建远端仓库与 Project、完成结构化回读并激活 Codex/Claude。初始化后用户已经能直接打开 Project；再开启新的 Agent 会话，执行输出中的 `agx.first-use/v1` 合同，创建 Bootstrap Verification Issue、Project item 和未合并 PR。`agx status` / `agx diagnose` 会回读这些 evidence，并报告 `awaiting` 或 `effective`。如果远端回读期间达到 deadline 或被取消，命令返回 `AGX-STATUS-INCONCLUSIVE`，不会把未完成的观察误报为 drift；远端状态可能已变化，应重新运行 `agx status` 或 `agx diagnose`，该失败路径不会执行任何写入。

卸载边界也要直接理解：`agx uninstall` 只撤销回执证明由 AGX 新增的本地文件和 provider 激活；不会删除 `<owner>/agent-control`、`<owner>/agent-contracts` 或关联的 GitHub Project。远端资源要由 operator 自己决定是否归档、迁移或删除。

## 产品边界

AGX 负责：

- `plan`、`apply`、`init`、`status`、`diagnose`、`uninstall`、`version`
- 消费固定版本与摘要的唯一 `agent-plugins` Release artifact
- 从版本化、摘要固定的干净模板创建部署专属 `agent-control` / `agent-contracts` 仓库
- 创建、关联并结构化回读部署专属 GitHub Project
- 生成版本化 first-use contract，并回读最小 Agent smoke evidence

AGX 不负责：

- 日常 Task 创建、分配、调度与日志
- Multica Task/Runtime 编排或 Multica 服务端生命周期
- 隐式消费 sibling checkout、可变 `main` 或本地 Marketplace cache
- 复制参考仓的 Git 历史、live Issues/PR、凭据、回执、用户路径或当前工作状态
- 接管、覆盖或在失败/卸载时自动删除用户的远端仓库
- 保存或管理 Codex/Claude 凭据

## 当前开发入口

```powershell
go test ./...
go run ./cmd/agx version
go run ./cmd/agx help
go run ./cmd/agx mascot
go run ./cmd/agx init --help
```

## 本地 Bundle 部署

正式二进制内置经过 Schema 校验、版本固定的 production Bundle manifest。普通用户不需要另外下载或寻找 `bundle.json`；`apply` 会按内置 manifest 下载唯一的 `agent-plugins` GitHub Release 资产、分别校验压缩资产和解压内容的 SHA-256、安全解包并写入非敏感回执。

首次 `apply` 的 `--root` 必须尚不存在；AGX 会原子创建它。不要预先创建空目录，因为无法证明归属的既有目录会被当作冲突而保留。

```powershell
go run ./cmd/agx apply --root D:\agx\installations\default
go run ./cmd/agx init --guided --root D:\agx\installations\default
go run ./cmd/agx init --root D:\agx\installations\default --github-owner octo-lab --provider codex --profile core --evidence-profile github-delivery/v1
go run ./cmd/agx init --root D:\agx\installations\default --github-owner octo-lab --provider codex --profile core --evidence-profile github-delivery/v1 --apply
go run ./cmd/agx status --root D:\agx\installations\default
go run ./cmd/agx diagnose --root D:\agx\installations\default
go run ./cmd/agx uninstall --root D:\agx\installations\default
```

开发、审计或受控回归需要显式 manifest 时，仍可覆盖内置 production Bundle：

```powershell
go run ./cmd/agx apply --bundle testdata/bundles/v2-production-agx-bootstrap-20260816.1.json --root D:\agx\installations\review
```

`--bundle` 与内置 production manifest 二选一；普通部署省略它，显式指定时 AGX 不会再混入内置 manifest。

重复应用同一 Bundle 或重复执行同一初始化不会重复写入；不同 Bundle 不会覆盖既有安装。初始化中断后，重试会先验证回执记录的远端仓库及其初始提交，再只继续缺失的步骤；AGX 不把一个碰巧同名的仓库当成自己创建的仓库。

`uninstall` 先撤销初始化回执证明由 AGX 新增的插件。若 Marketplace 也由 AGX 新增，随后一并撤销；若它在初始化前已经存在，AGX 会保留它，并在它仍引用安装目录时停止删除对应 Bundle。两个部署仓、关联 Project、任何未知文件和预存运行端对象都会保留。此阶段最高安装状态是 `configured`；只有当前 Evidence Profile 的全部必需证据完成后才会输出 `verified`。`github-delivery/v1` 不要求 Multica 证据，`multica-execution/v1` 则同时要求 GitHub 与 Multica 证据。

## 初始化能力包

首次运行优先使用 human-only 的 guided 入口；它不执行 mutation，也不输出 JSON：

```powershell
agx init --guided --root D:\agx\installations\default
```

自动化仍使用显式 `init` 参数。显式 `init` 必须指定 GitHub owner、运行端和 Evidence Profile；不传 `--profile` 时默认是 `core`，仓库默认私有。`github-delivery/v1` 只以 GitHub 交付资源为 subject；`multica-execution/v1` 还必须显式指定格式正确的 workspace、runtime 和 agent UUID。未知 Profile、缺少选择器或格式错误会在文件系统及远端写入前停止。guided 入口为了首次部署可用性默认建议 `github` 能力包和 `github-delivery/v1` Evidence Profile，并要求用户在输出 apply 命令前确认：

首次初始化前先确认本机入口，不需要把任何凭据交给 AGX：

```powershell
git --version
gh auth status
codex --version   # 只选 Claude 时可省略
claude --version  # 只选 Codex 时可省略
```

```powershell
agx init --root D:\agx\installations\default --github-owner octo-lab --provider codex --profile core --evidence-profile github-delivery/v1
agx init --root D:\agx\installations\default --github-owner octo-lab --provider both --profile full --evidence-profile github-delivery/v1 --visibility public
agx init --root D:\agx\installations\default --github-owner octo-lab --provider both --profile full --evidence-profile multica-execution/v1 --multica-workspace-id 123e4567-e89b-42d3-a456-426614174000 --multica-runtime-id 123e4567-e89b-42d3-a456-426614174001 --multica-agent-id 123e4567-e89b-42d3-a456-426614174002 --control-repo my-control --contracts-repo my-contracts --apply --output json
```

不带 `--apply` 的结果是只读初始化计划；带 `--apply` 的成功结果中，`repositories` 记录目标 URL、visibility、初始 commit、模板 digest 与必需路径，`project` 记录 number、node ID、URL、visibility 和控制仓 link，`first_use_contract` / `first_use` 提供版本化合同和每个 Agent 一条自包含 prompt。初始化回执 v4 另外固定 Evidence Profile、deployment digest 和 subject digest，但不保存 token、API key、cookie、授权头或原始凭据。`status` / `diagnose` 使用同一 evaluator：只有当前 Profile 的必需观测全部匹配绑定、在 freshness 窗口内且没有拒绝或漂移结果时才会输出 `verified`；其它 Profile 的观测不会补齐当前 Profile。旧版回执仍可读取，并保持原有非 `verified` 状态。部分成功会保留可恢复回执并返回错误，不会删除已经创建的远端资源。

若默认的 `<owner>/agent-control` 或 `<owner>/agent-contracts` 已存在，AGX 会在写入前停止，不会把它们静默当成自己创建的仓库。此时用 `--control-repo` / `--contracts-repo` 选择未占用名称，再重新运行只读计划。若 provider 已有同名 Marketplace 指向别处，AGX 同样不会改绑；先确认并处理原来源，或只选择没有冲突的 provider。初始化中断时没有单独的 `agx resume` 命令：修复输出的问题后，原样重跑此前的 `agx init ... --apply`，AGX 会根据恢复回执继续缺失步骤。

| 能力包 | 插件能力 |
| --- | --- |
| `core` | 问题求解、自我改进、知识维护、方案盘问 |
| `github` | `core` 加 Issue、交付和 PR 工作流 |
| `team` | `github` 加多 Agent 编排 |
| `full` | `team` 加账户容量与会话 Token 观测 |

初始化在任何写入前验证安装回执与模板版本，检查 `git` / `gh` 登录状态、`project` scope、两个目标仓和同名 Project 不存在，并读取运行端的 JSON Inventory。安装组件路径包含 symlink/junction 等重解析点、目标 CLI 缺失、Inventory 不可读、同名资源或 Marketplace 冲突，或已有目标插件处于禁用状态时都会停止；AGX 不覆盖用户既有配置。仓库创建后还会回读初始 commit、Issues 开关和模板必需路径。成功后请新建一个 Agent 会话，让新的 Skill 清单生效并执行 first-use contract；安装状态仍为 `configured`，不会因此成为 `verified`。

## Preview 安装包（仅供测试）

PR 的 `preview-package` 工作流会生成 Windows x64 ZIP、Ubuntu x64 tar.gz 和
`checksums.txt`。它们是可复现的测试产物，不会创建 GitHub Release，也不表示 AGX 已
通过真实 Multica 安装验收。

Windows 下载对应 ZIP 与 `checksums.txt` 后，在同一目录执行：

```powershell
$archive = Get-ChildItem -Filter 'agx_*_windows_amd64.zip' | Select-Object -First 1
$line = Get-Content .\checksums.txt | Where-Object { $_ -match ([regex]::Escape($archive.Name) + '$') }
$expected = ($line -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive.FullName).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "checksum mismatch for $($archive.Name)" }
Expand-Archive -LiteralPath $archive.FullName -DestinationPath .\agx-preview
.\agx-preview\agx.exe version
```

输出的是该 preview 构建的版本；它只证明二进制可下载、校验与运行，**不**证明部署或
`verified` 状态。

正式版本由 `v*` 标签触发，发布 Windows amd64 ZIP、Linux amd64 tar.gz 与 `checksums.txt` 到 GitHub Releases；二进制版本来自标签。

认证发布平台暂定为 Windows 11 x64 与 Ubuntu 24.04 x64。其他平台在取得端到端证据前只能标记为 preview。

## 上游关系

- [zaurakworks/agent-control](https://github.com/zaurakworks/agent-control)
- [zaurakworks/agent-plugins](https://github.com/zaurakworks/agent-plugins)
- [zaurakworks/agent-contracts](https://github.com/zaurakworks/agent-contracts)
- [四仓部署关系研究](docs/research/zaurakworks-four-repository-deployment.md)
- [Multica concepts](https://multica.ai/docs/zh/concepts)

本仓目前由 `2233admin` 建立，用于推进 AGXCLI。除非上游明确接受或迁移，本仓不代表 `zaurakworks` 的官方发行版。

## 历史设计材料

当前可审阅的 D1 基线在仓内维护：

- [产品需求](docs/spec/PRD.md)
- [软件设计](docs/spec/SDD.md)
- [任务与 Gate](docs/spec/TASKS.md)
- [仓库归属决策](docs/decisions/repository-provenance.md)

这些文档同时记录长期 D1 设想和当前安全边界；当前分支的单一插件源、模板与部署仓初始化能力以本 README 和 Issue #33 为准。

## 贡献流程

1. 先创建有边界和验收标准的 Issue。
2. 从 `main` 创建短生命周期分支。
3. 测试通过后提交 PR；单维护者可在 required CI 全绿后自合并。
4. 不把本地 `configured` 描述成外部系统 `verified`。

License: Apache-2.0。
