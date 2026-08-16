# AGXCLI D1 产品需求基线

状态：规格基线。它定义要交付的合同，**不是**功能已完成的声明。

## 产品目标

AGXCLI (`agx`) 让用户针对一个 GitHub 仓库得到可解释、可恢复的 agent-control/agent-plugins 安装与生命周期体验。它输出确定性计划，取得一次与计划哈希绑定的批准，并留下可审计的非敏感回执。

唯一的成功终态是 `verified`：AGX 必须同时回读 GitHub acceptance Issue 与 Multica Task/Runtime 证据，且两侧与安装 ID 一致。组件已复制、资源已配置、Task 正在运行或 mock 已通过，都不是安装成功。

## D1 命令面

`init`、`plan`、`apply`、`status`、`verify`、`resume`、`diagnose`、`support-bundle`、`upgrade`、`rollback`、`uninstall`、`version` 构成 D1 的公共入口。实际功能按 Issue 依赖逐步实现；未实现的命令必须安全失败或清楚说明 unsupported，不能制造外部副作用。

## Agent 调用层

AGX 是部署 CLI，不是 skill。Agent 可以通过一个薄的 AGX skill 按受控流程调用 `agx`，但 skill 不得重新实现部署逻辑。它只定义何时做只读发现、何时请求用户批准、如何解释 receipt，以及遇到 `blocked_preflight` 或 `needs_manual_cleanup` 时何时停止并给出下一步。

所有环境发现、计划、外部写入、恢复、诊断、升级、回滚和卸载仍由 `agx` 执行。skill 不保存或索取凭据、不直接调用 GitHub/Multica、不解析 Multica 人类输出，也不能将 `configured`、mock 或局部配置表述为 `verified`。

## 硬边界

- 不做日常 Task 的 CRUD、分配、调度或日志。
- 不 fork/vendor Multica，不调用私有 HTTP，不解析人类可读输出，不部署 Multica 服务端。
- 不把 `agent-control` 与 `agent-plugins` 合并到本仓；生产只消费 Bundle-pinned immutable Release artifact。
- 不在配置、日志、计划、回执、fixture 或支持包中保存凭据。
- `status` 无写入；不能证明 AGX ownership 的资源、未知资源和凭据不得因 rollback/uninstall 被清除。

## 支持与证据口径

Windows 11 x64 与 Ubuntu 24.04 x64 是候选 D1 平台，但在真实双平台验收之前只能标为 preview。真实验收需要官方 Multica CLI、认证的可丢弃 Workspace、在线 Runtime、可丢弃 GitHub 仓和 GitHub/Multica 双侧回读；这些输入当前不可用，不能由 mock 替代。
