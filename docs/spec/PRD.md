# AGXCLI D1 产品需求基线

状态：规格基线。它定义要交付的合同，**不是**功能已完成的声明。

## 产品目标

AGXCLI (`agx`) 让用户得到可解释、可恢复的插件安装与部署仓初始化体验。它安装唯一的 `agent-plugins` 发行源，从版本化模板创建用户拥有的 `agent-control` 与 `agent-contracts` 仓库，输出确定性计划并留下可审计的非敏感回执。

唯一的成功终态是 `verified`：AGX 必须同时回读 GitHub acceptance Issue 与 Multica Task/Runtime 证据，且两侧与安装 ID 一致。组件已复制、资源已配置、Task 正在运行或 mock 已通过，都不是安装成功。

## D1 命令面

`init`、`plan`、`apply`、`status`、`verify`、`resume`、`diagnose`、`support-bundle`、`upgrade`、`rollback`、`uninstall`、`version` 构成 D1 的公共入口。实际功能按 Issue 依赖逐步实现；未实现的命令必须安全失败或清楚说明 unsupported，不能制造外部副作用。

## 硬边界

- 不做日常 Task 的 CRUD、分配、调度或日志。
- 不 fork/vendor Multica，不调用私有 HTTP，不解析人类可读输出，不部署 Multica 服务端。
- 不把三个参考仓的运行状态合并到本仓；生产只消费 Bundle-pinned `agent-plugins` immutable Release artifact。
- `agent-control` 与 `agent-contracts` 必须从固定版本和摘要的干净模板创建，不复制上游历史、live Issues/PR、凭据、回执、用户路径或当前工作状态。
- 初始化不得接管或覆盖同名远端仓库；失败、重试和卸载都不得自动删除远端仓库。
- 不在配置、日志、计划、回执、fixture 或支持包中保存凭据。
- `status` 无写入；不能证明 AGX ownership 的资源、未知资源和凭据不得因 rollback/uninstall 被清除。

## 支持与证据口径

Windows 11 x64 与 Ubuntu 24.04 x64 是候选 D1 平台，但在真实双平台验收之前只能标为 preview。官方 Multica CLI、认证的可丢弃 Workspace、在线 Runtime 和 GitHub/Multica 双侧回读已经完成一次有边界的 preflight；这只证明适配器路径可行。每个实际 AGX adapter 命令及完整安装仍须取得独立真实证据，不能由 mock 替代。
