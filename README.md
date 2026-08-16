# AGXCLI

<img src="assets/oc/agx-oc-github-banner-16x9.png" width="100%" alt="AGXCLI 黑白 Macintosh CRT 猫娘协调员，置于部署与验收诊断界面中。">

AGX 的猫娘协调员对应安装、计划、验收和回执；她是项目身份，不代表目标环境已通过 `verified`。其余画幅与 GitHub 文档落点见 [OC kit](assets/oc/README.md)。

AGXCLI (`agx`) 是面向 `agent-control` 与 `agent-plugins` Bundle 的小型部署 CLI：下载固定 Release、校验摘要、安全解包、检查状态并按所有权卸载。

> 当前状态：本地 Bundle 部署闭环和 Codex/Claude 初始化阶段已实现。Multica 编排不属于当前发布阻塞项。

## 目标体验

用户下载一个独立可执行文件，然后运行：

```text
agx apply --bundle bundle.json --root D:\agx\installations\default
agx init --root D:\agx\installations\default --provider codex --profile full
```

AGX 下载 Bundle 固定的两个资产，校验 SHA-256，在同一磁盘暂存后原子落盘，并写入不含凭据的回执。随后 `init` 只从该回执定位受 AGX 管理的 `agent-plugins` 组件，将选定能力激活到 Codex/Claude，执行结构化回读并给出可直接复制的首次使用提示。安装完整时状态仍为 `configured`；`verified` 是保留状态，初始化不会伪造它。

## 产品边界

AGX 负责：

- `plan`、`apply`、`init`、`status`、`uninstall`、`version`
- 消费固定版本与摘要的 `agent-control` / `agent-plugins` Release artifact

AGX 不负责：

- 日常 Task 创建、分配、调度与日志
- Multica Task/Runtime 编排或 Multica 服务端生命周期
- 隐式消费 sibling checkout、可变 `main` 或本地 Marketplace cache
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

当前可用的部署闭环会下载 Bundle 固定的两个 GitHub Release 资产、校验 SHA-256、安全解包并写入非敏感回执：

```powershell
go run ./cmd/agx apply --bundle testdata/bundles/v1-production-agx-bootstrap-20260816.1.json --root D:\agx\installations\default
go run ./cmd/agx init --root D:\agx\installations\default --provider codex --profile core
go run ./cmd/agx status --root D:\agx\installations\default
go run ./cmd/agx uninstall --root D:\agx\installations\default
```

重复应用同一 Bundle 或重复执行同一初始化不会重复写入；不同 Bundle 不会覆盖既有安装。`uninstall` 先撤销初始化回执证明由 AGX 新增的插件和 Marketplace，再移除 AGX 自有文件；预先存在的运行端对象不会被删除，若它们仍引用安装目录则安全停止并要求用户先解除引用。未知文件会保留。此阶段最高安装状态是 `configured`；GitHub 与 Multica 双侧证据完成前不会输出 `verified`。

## 初始化能力包

`init` 必须显式指定运行端，能力包默认是 `core`：

```powershell
agx init --root D:\agx\installations\default --provider codex --profile core
agx init --root D:\agx\installations\default --provider both --profile full
```

| 能力包 | 插件能力 |
| --- | --- |
| `core` | 问题求解、自我改进、知识维护、方案盘问 |
| `github` | `core` 加 Issue、交付和 PR 工作流 |
| `team` | `github` 加多 Agent 编排 |
| `full` | `team` 加账户容量与会话 Token 观测 |

初始化在任何写入前读取运行端的 JSON Inventory。目标 CLI 缺失、Inventory 不可读、同名 Marketplace 指向其他来源，或已有目标插件处于禁用状态时都会停止；AGX 不覆盖用户既有配置。成功后请新建一个运行端会话，让新的 Skill 清单生效。

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
- [Multica concepts](https://multica.ai/docs/zh/concepts)

本仓目前由 `2233admin` 建立，用于推进 AGXCLI。除非上游明确接受或迁移，本仓不代表 `zaurakworks` 的官方发行版。

## 历史设计材料

当前可审阅的 D1 基线在仓内维护：

- [产品需求](docs/spec/PRD.md)
- [软件设计](docs/spec/SDD.md)
- [任务与 Gate](docs/spec/TASKS.md)
- [仓库归属决策](docs/decisions/repository-provenance.md)

这些文档记录过更大的 D1 设想，仅作为历史设计材料；已发布的 AGX 0.1 范围是本地 Bundle 部署闭环，当前分支新增的初始化能力以本 README 前述合同和 Issue #33 为准。

## 贡献流程

1. 先创建有边界和验收标准的 Issue。
2. 从 `main` 创建短生命周期分支。
3. 测试通过后提交 PR；单维护者可在 required CI 全绿后自合并。
4. 不把本地 `configured` 描述成外部系统 `verified`。

License: Apache-2.0。
