# 仓库归属与上游关系

状态：当前仓归属、`2233admin` 的 security/release/provenance owner 身份及 `agent-plugins` Bundle bootstrap Release 已确认；Source 已合入 `zaurakworks/agent-system`。AGX 不跟随 Source git `main`。

## 当前事实

- AGXCLI 产品仓是 [`2233admin/agx`](https://github.com/2233admin/agx)。
- Go module 为 `github.com/2233admin/agx`，发行二进制名为 `agx`。
- `2233admin` 目前负责推进本仓；此事实不把本仓表示为 `zaurakworks` 的官方发行版。
- Plugin **Source** 是 [`zaurakworks/agent-system`](https://github.com/zaurakworks/agent-system)（原 `agent-control` 已改名并合仓）。AGX 不安装、不 clone、也不跟随该仓的 git `main`。
- 当前生产 **Distribution** 输入仍是 [`2233admin/agent-plugins`](https://github.com/2233admin/agent-plugins) 的不可变 Release `agx-bootstrap-20260816.1`（commit `eb10f7f14cc05b70b6c27a121c6f72d1b3b9edb8`）。在带 digest 的新 Release 出现前不得把未打 tag 的 `agent-system` main SHA 写成生产 pin。
- `2233admin/agent-control` 只是改名前残留，不是 Source fork 名，也不是模板源。
- 每次部署创建由用户账户拥有的 `agent-control` 与 `agent-contracts` 目标仓库；默认私有，名称和 owner 必须显式进入初始化计划与回执。这些部署仓来自 AGX 干净模板，不是 Source 整树的副本。

## 协作与供应链边界

对上游的改动先在 `2233admin/agent-system` 上按切片修补，再酌情向 `zaurakworks/agent-system` 开 PR。上游未及时合入时，AGX 仍可消费 `2233admin` 自己的 immutable Release。生产安装只消费 Bundle 声明、固定版本和已验证摘要所指向的 Release artifact。

当前生产 Bundle 的 `sources.agent_plugins` 仍记录这次 Release 的历史身份：`upstream_repository` 为 `zaurakworks/agent-plugins`，`distribution_repository` 为 `2233admin/agent-plugins`。这不是跟 Source `main`，也不是把已改名消失的 `zaurakworks/agent-control` 当作生产 pin。

AGX 内置的 bootstrap 模板是干净子集：README、AGENTS、Issue Forms、schema、validator、示例和最小工作入口。模板参考：

- `zaurakworks/agent-plugins` @ `ad07742ade0f0039ed1df1a9262e8f087117fca0`
- `zaurakworks/agent-system` @ `b0e6e0e8244ef518f671e2326745cd67c6d2307a`（改名后仍可寻址的历史蒸馏快照，不是 untagged main）
- `zaurakworks/agent-contracts` @ `5bb8ea0b54f063b0758c294b73ea270ba69322d2`

模板不复制 CAP、`.cap/`、`src/agent_system/`、仓库历史、live Issues/PR、凭据、回执、用户绝对路径、`work/records/` 或当前任务状态。模板版本、内容摘要和三个参考提交必须同时记录在 Bundle 与安装回执中。生产 Bundle / 模板 references 不得指向 `zaurakworks/agent-control`，也不得把未打 tag 的 `agent-system` main SHA 写成生产 pin。

初始化先执行只读 preflight 并生成确定性计划，再由显式 apply 创建目标仓库。创建使用结构化 GitHub/Git 命令和回读，不改全局 Git 配置，不接管同名仓库，也不在失败或卸载时自动删除远端仓库。部分成功必须写入可恢复回执，重试时先验证已经创建的仓库和初始提交。

AGX 不得扫描 sibling checkout、可变 `main`、内部目录或本地 Marketplace cache 来组成生产安装或仓库模板。开发 override 必须显式启用并在回执中降级 provenance；它不能被表述为生产可验证安装。本地完整树是 `configured`，不是 Evidence Profile 的 `verified`。

## 不变的产品边界

AGX 是安装、部署、恢复、诊断、升级、回滚和卸载 CLI，不是日常 Task 的创建、分配、调度或日志产品。Multica 仅通过版本化的官方 CLI adapter 接入；不使用私有 HTTP、不解析面向人的 CLI 输出，也不部署或管理 Multica 服务端。

## 仍待关闭的 Gate

Bundle v2 与部署仓初始化由 Issue #33 及其 Draft PR 维护。官方 Multica CLI、认证 disposable Workspace、在线 Runtime 与双侧验收证据不属于这次 bootstrap 闭环；在取得相应证据前仍不得声明 `verified`。
