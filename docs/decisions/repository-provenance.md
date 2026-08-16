# 仓库归属与上游关系

状态：当前仓归属、`2233admin` 的 security/release/provenance owner 身份及 AGX Bundle bootstrap Release 已确认；真实 Multica live Gate 仍未满足。

## 当前事实

- AGXCLI 产品仓是 [`2233admin/agx`](https://github.com/2233admin/agx)。
- Go module 为 `github.com/2233admin/agx`，发行二进制名为 `agx`。
- `2233admin` 目前负责推进本仓；此事实不把本仓表示为 `zaurakworks` 的官方发行版。
- `zaurakworks/agent-control` 与 `zaurakworks/agent-plugins` 保持各自独立的上游仓库。

## 协作与供应链边界

对上游的改动先经相应的 `2233admin` fork 提交 PR，除非上游另行接受或迁移仓库。AGX 不合并、fork 或 vendor 两个上游的实现；生产安装只消费 Bundle 声明、固定版本和已验证摘要所指向的不可变 Release artifact。当前受信输入来自 `2233admin/agent-control` 与 `2233admin/agent-plugins` 的受保护 prerelease；它们仍分别对应 `zaurakworks` 的两个独立上游。

AGX 不得扫描 sibling checkout、可变 `main`、内部目录或本地 Marketplace cache 来组成生产安装输入。开发 override 必须显式启用并在回执中降级 provenance；它不能被表述为生产可验证安装。

## 不变的产品边界

AGX 是安装、部署、恢复、诊断、升级、回滚和卸载 CLI，不是日常 Task 的创建、分配、调度或日志产品。Multica 仅通过版本化的官方 CLI adapter 接入；不使用私有 HTTP、不解析面向人的 CLI 输出，也不部署或管理 Multica 服务端。

## 仍待关闭的 Gate

Bundle v1 production fixture 与 D1 安全/发布政策分别由 #11 与 #9 引入；它们在合并并回读前仍不解锁依赖实现。官方 Multica CLI、认证 disposable Workspace、在线 Runtime 与双侧验收证据仍不可用，相关 live Gate 必须保持 blocked。
