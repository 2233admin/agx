# 仓库归属与上游关系

状态：当前仓归属、`2233admin` 的 security/release/provenance owner 身份及 `agent-plugins` Bundle bootstrap Release 已确认；部署仓初始化合同由 Issue #33 维护。

## 当前事实

- AGXCLI 产品仓是 [`2233admin/agx`](https://github.com/2233admin/agx)。
- Go module 为 `github.com/2233admin/agx`，发行二进制名为 `agx`。
- `2233admin` 目前负责推进本仓；此事实不把本仓表示为 `zaurakworks` 的官方发行版。
- `zaurakworks/agent-plugins` 是 AGX 唯一安装的插件源仓库。
- `zaurakworks/agent-control` 与 `zaurakworks/agent-contracts` 是 bootstrap 模板的参考仓库，不是要安装或复制的运行时组件。
- 每次部署创建由用户账户拥有的 `agent-control` 与 `agent-contracts` 目标仓库；默认私有，名称和 owner 必须显式进入初始化计划与回执。

## 协作与供应链边界

对上游的改动先经相应的 `2233admin` fork 提交 PR，除非上游另行接受或迁移仓库。生产安装只消费 Bundle 声明、固定版本和已验证摘要所指向的 `agent-plugins` 不可变 Release artifact。当前分发输入来自 `2233admin/agent-plugins` 的受保护 prerelease，并在 Bundle 中同时记录 `zaurakworks/agent-plugins` 上游来源。

AGX 内置的 bootstrap 模板分别参考固定提交的 `agent-plugins`、`agent-control` 与 `agent-contracts`。模板只保留可移植的规则、Issue Forms、schema、validator、示例和最小工作入口；不复制仓库历史、live Issues/PR、凭据、回执、用户绝对路径、运行记录或当前任务状态。模板版本、内容摘要和三个参考提交必须同时记录在 Bundle 与安装回执中。

初始化先执行只读 preflight 并生成确定性计划，再由显式 apply 创建目标仓库。创建使用结构化 GitHub/Git 命令和回读，不改全局 Git 配置，不接管同名仓库，也不在失败或卸载时自动删除远端仓库。部分成功必须写入可恢复回执，重试时先验证已经创建的仓库和初始提交。

AGX 不得扫描 sibling checkout、可变 `main`、内部目录或本地 Marketplace cache 来组成生产安装或仓库模板。开发 override 必须显式启用并在回执中降级 provenance；它不能被表述为生产可验证安装。

## 不变的产品边界

AGX 是安装、部署、恢复、诊断、升级、回滚和卸载 CLI，不是日常 Task 的创建、分配、调度或日志产品。Multica 仅通过版本化的官方 CLI adapter 接入；不使用私有 HTTP、不解析面向人的 CLI 输出，也不部署或管理 Multica 服务端。

## 仍待关闭的 Gate

Bundle v2 与部署仓初始化由 Issue #33 及其 Draft PR 维护。官方 Multica CLI、认证 disposable Workspace、在线 Runtime 与双侧验收证据不属于这次 bootstrap 闭环；在取得相应证据前仍不得声明 `verified`。
