# AGXCLI

AGXCLI (`agx`) 是面向 `agent-control` 与 `agent-plugins` 的安装、部署、恢复和生命周期 CLI。它通过官方 Multica CLI 适配器使用舰队与任务能力，但不 fork Multica、不部署 Multica 服务端，也不接管日常任务调度。

> 当前状态：早期工程基线。尚未发布可用于生产环境的安装器。

## 目标体验

用户下载一个独立可执行文件，然后运行：

```text
agx init https://github.com/OWNER/REPOSITORY
```

AGX 完成环境发现、确定性计划、用户批准、事务化应用、安全验收和回执。只有 GitHub 与 Multica 两侧的端到端证据一致时，安装才进入 `verified`。

## 产品边界

AGX 负责：

- `init`、`plan`、`apply`、`status`、`verify`、`resume`
- `diagnose`、`support-bundle`
- `upgrade`、`rollback`、`uninstall`、`version`
- 消费固定版本与摘要的 `agent-control` / `agent-plugins` Release artifact

AGX 不负责：

- 日常 Task 创建、分配、调度与日志
- Multica 服务端、Compose、Helm、数据库、TLS 或 Runtime 生命周期
- 隐式消费 sibling checkout、可变 `main` 或本地 Marketplace cache

## 当前开发入口

```powershell
go test ./...
go run ./cmd/agx version
go run ./cmd/agx help
```

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

认证发布平台暂定为 Windows 11 x64 与 Ubuntu 24.04 x64。其他平台在取得端到端证据前只能标记为 preview。

## 上游关系

- [zaurakworks/agent-control](https://github.com/zaurakworks/agent-control)
- [zaurakworks/agent-plugins](https://github.com/zaurakworks/agent-plugins)
- [Multica concepts](https://multica.ai/docs/zh/concepts)

本仓目前由 `2233admin` 建立，用于推进 AGXCLI。除非上游明确接受或迁移，本仓不代表 `zaurakworks` 的官方发行版。

## 贡献流程

1. 先创建有边界和验收标准的 Issue。
2. 从 `main` 创建短生命周期分支。
3. 测试通过后提交 Draft PR。
4. 不把 mock 结果描述为真实 Multica 端到端证据。

License: Apache-2.0。
