# AGXCLI D1 软件设计基线

状态：设计合同。适配器的真实能力仅在 live Gate 取得证据后才能声明支持。

## 分层

1. `cmd/agx` 负责解析、呈现和稳定退出码；它不拥有状态机，也不直接进行外部写入。
2. domain 定义 DesiredState、ObservedState、Plan、Step、Receipt、Diagnostic、installation ID、ownership、desired hash、幂等策略、补偿类别，以及独立于具体 Hub 的 Evidence Profile/Observation/Evidence Evaluator（`EvidenceProfileID`、`Observation`、`Evaluate`）；遗留的固定双侧 `Verification`/`NewVerifiedReceipt` 仍保留以保证旧回执可读，但新代码使用显式 Evidence Profile 而不是隐式假设 GitHub+Multica 都存在。
3. plan/saga/journal 基于 domain 生成可重复的计划、执行已批准步骤、先发现后恢复，并在不确定外部结果时停止或进入 `needs_manual_cleanup`。
4. bootstrap 层渲染版本化、摘要固定的 `agent-control` 与 `agent-contracts` 干净模板；repository 层用原生 Git/GitHub 结构化命令执行全目标 preflight、创建、推送与回读。
5. provider 层只从已安装的 `agent-plugins` 组件激活 Codex/Claude，并在任何写入前检查 CLI、Inventory、来源和 ownership 冲突。
6. 未来的 Multica adapter 只能包装版本化官方 CLI 的机器可读接口；必须使用结构化参数、超时、exit-code 捕获、JSON schema 验证和脱敏。

## 状态和安全语义

允许状态至少包括 `planned`、`provisioning`、`needs_resume`、`initialized`、`configured`、`blocked_preflight`、`awaiting_verification`、`verified` 与 `needs_manual_cleanup`。`configured`、`initialized` 和 `awaiting_verification` 绝不等于外部验收成功。恢复必须先重新发现远端仓库、初始提交和 provider 状态；不确定的外部结果不得触发破坏性补偿。

序列化边界采用默认拒绝：未知敏感字段、token、cookie、OAuth code、邮箱、业务正文和完整本地路径不得进入日志、fixture、回执或支持包。

## Bundle 和验收

Bundle v2 包含 schema/version、兼容范围、唯一 `agent-plugins` 上游与分发 provenance、release commit、asset/content SHA-256，以及 bootstrap 模板版本、内容摘要和三个参考仓固定提交。生产解析在任何 auth-dependent mutation 前验证完整性，并拒绝 sibling checkout、mutable ref 与旧的双组件 Bundle。

初始化计划包含安装 ID、目标 owner/name/visibility、模板版本/摘要、provider/profile 和待新增对象。所有目标仓与 provider 必须在第一次写入前完成只读 preflight。每创建一个仓库都立即持久化回执；若外部命令返回不确定结果，先结构化回读并进入 `needs_resume` 或 `needs_manual_cleanup`。卸载只撤销可证明由 AGX 新增的 provider 对象并删除本地 owned files，远端仓库始终保留。

验收 Issue 使用稳定的 installation marker；同一 installation ID 不得重复创建。Receipt 只有在为该 installation 显式选择的 Evidence Profile（`github-delivery/v1` 或 `multica-execution/v1`）的全部必需 Observation 都满足、且与 installation ID 匹配时，才能由 Evidence Evaluator 写为 `verified`；`github-delivery/v1` 不需要任何 Multica 证据即可 `verified`，`multica-execution/v1` 才在其基础上额外要求匹配的 Multica Workspace/Runtime/Agent/Task-Run 证据。

## Live Gate 状态

官方 Multica CLI v0.4.26 已完成一次认证 disposable Workspace、在线 Runtime、Issue 创建/分配、执行消息和清理的有边界 preflight。该证据允许开始实现结构化 CLI adapter，但不等于 AGX 安装已通过。资源操作、Task 取消语义以及完整 GitHub -> Multica -> Runtime 双回读仍须随实际命令逐项验证；fake contract test 只能验证本地设计，不能关闭这些 Gate。
