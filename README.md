# AGXCLI

<img src="assets/oc/agx-oc-github-banner-16x9.png" width="100%" alt="AGXCLI 黑白 Macintosh CRT 猫娘协调员，置于部署与验收诊断界面中。">

AGX 的猫娘协调员对应安装、计划、验收和回执；她是项目身份，不代表目标环境已通过 `verified`。其余画幅与 GitHub 文档落点见 [OC kit](assets/oc/README.md)。

AGXCLI (`agx`) 是小型部署 CLI：它安装固定版本的 `agent-plugins`，再从内置的版本化模板创建部署专属的 `agent-control` 与 `agent-contracts` GitHub 仓库，激活 Codex/Claude，并用本地回执管理恢复、状态和安全卸载。

> 当前状态：本地 Bundle 部署闭环和 Codex/Claude 初始化阶段已实现。Multica 编排不属于当前发布阻塞项。

## 目标体验

用户下载一个独立可执行文件，先安装插件发行包，再预演初始化：

```text
agx apply --bundle bundle.json --root D:\agx\installations\default
agx init --root D:\agx\installations\default --github-owner octo-lab --provider codex --profile full
agx init --root D:\agx\installations\default --github-owner octo-lab --provider codex --profile full --apply
```

第一条 `init` 只执行 GitHub、模板、安装和 provider 的只读 preflight，并打印将要创建的仓库与激活对象；只有带 `--apply` 才会产生写入。AGX 默认创建私有的 `octo-lab/agent-control` 和 `octo-lab/agent-contracts`，每创建一个仓库就持久化一次恢复回执，然后从已安装的 `agent-plugins` 激活选定能力并结构化回读。初始化完成仍不等于外部验收完成；`verified` 是保留状态。

## 产品边界

AGX 负责：

- `plan`、`apply`、`init`、`status`、`uninstall`、`version`
- 消费固定版本与摘要的唯一 `agent-plugins` Release artifact
- 从版本化、摘要固定的干净模板创建部署专属 `agent-control` / `agent-contracts` 仓库

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

当前可用的部署闭环会下载 Bundle 固定的单个 `agent-plugins` GitHub Release 资产、校验 SHA-256、安全解包并写入非敏感回执：

首次 `apply` 的 `--root` 必须尚不存在；AGX 会原子创建它。不要预先创建空目录，因为无法证明归属的既有目录会被当作冲突而保留。

```powershell
go run ./cmd/agx apply --bundle testdata/bundles/v2-production-agx-bootstrap-20260816.1.json --root D:\agx\installations\default
go run ./cmd/agx init --root D:\agx\installations\default --github-owner octo-lab --provider codex --profile core
go run ./cmd/agx init --root D:\agx\installations\default --github-owner octo-lab --provider codex --profile core --apply
go run ./cmd/agx status --root D:\agx\installations\default
go run ./cmd/agx uninstall --root D:\agx\installations\default
```

重复应用同一 Bundle 或重复执行同一初始化不会重复写入；不同 Bundle 不会覆盖既有安装。初始化中断后，重试会先验证回执记录的远端仓库及其初始提交，再只继续缺失的步骤；AGX 不把一个碰巧同名的仓库当成自己创建的仓库。

`uninstall` 先撤销初始化回执证明由 AGX 新增的插件。若 Marketplace 也由 AGX 新增，随后一并撤销；若它在初始化前已经存在，AGX 会保留它，并在它仍引用安装目录时停止删除对应 Bundle。两个部署仓以及任何未知文件和预存运行端对象都会保留。此阶段最高安装状态是 `configured`；GitHub 与 Multica 双侧证据完成前不会输出 `verified`。

## 初始化能力包

`init` 必须显式指定 GitHub owner 和运行端，能力包默认是 `core`，仓库默认私有：

```powershell
agx init --root D:\agx\installations\default --github-owner octo-lab --provider codex --profile core
agx init --root D:\agx\installations\default --github-owner octo-lab --provider both --profile full --visibility public
agx init --root D:\agx\installations\default --github-owner octo-lab --provider both --profile full --control-repo my-control --contracts-repo my-contracts --apply --output json
```

不带 `--apply` 的结果是只读初始化计划；带 `--apply` 的成功结果中，`repositories` 记录目标 URL、visibility、初始 commit 与模板 digest，`first_use` 数组按运行端提供结构化的 `provider` 与 `prompt`。部分成功会保留可恢复回执并返回错误，不会删除已经创建的远端仓库。

| 能力包 | 插件能力 |
| --- | --- |
| `core` | 问题求解、自我改进、知识维护、方案盘问 |
| `github` | `core` 加 Issue、交付和 PR 工作流 |
| `team` | `github` 加多 Agent 编排 |
| `full` | `team` 加账户容量与会话 Token 观测 |

初始化在任何写入前验证安装回执与模板版本，检查 `git` / `gh` 登录状态、两个目标仓不存在，并读取运行端的 JSON Inventory。安装组件路径包含 symlink/junction 等重解析点、目标 CLI 缺失、Inventory 不可读、同名仓库或 Marketplace 冲突，或已有目标插件处于禁用状态时都会停止；AGX 不覆盖用户既有配置。成功后请新建一个运行端会话，让新的 Skill 清单生效；安装状态仍为 `configured`，不会因此成为 `verified`。

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
