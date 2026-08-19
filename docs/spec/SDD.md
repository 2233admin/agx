# AGXCLI D1 软件设计基线

状态：设计合同。适配器的真实能力仅在 live Gate 取得证据后才能声明支持。

## 分层

1. `cmd/agx` 负责解析、呈现和稳定退出码；它不拥有状态机，也不直接进行外部写入。
2. domain 定义 DesiredState、ObservedState、Plan、Step、Receipt、版本化 Evidence Profile、类型化 observation、统一 evaluator、Diagnostic、installation ID、ownership、desired hash、幂等策略和补偿类别。
3. plan/saga/journal 基于 domain 生成可重复的计划、执行已批准步骤、先发现后恢复，并在不确定外部结果时停止或进入 `needs_manual_cleanup`。
4. bootstrap 层渲染版本化、摘要固定的 `agent-control` 与 `agent-contracts` 干净模板；repository 层用原生 Git/GitHub 结构化命令执行全目标 preflight、创建、推送与回读。
5. provider 层只从已安装的 `agent-plugins` 组件激活 Codex/Claude，并在任何写入前检查 CLI、Inventory、来源和 ownership 冲突。
6. 未来的 Multica adapter 只能包装版本化官方 CLI 的机器可读接口；必须使用结构化参数、超时、exit-code 捕获、JSON schema 验证和脱敏。

## 状态和安全语义

状态分成两条独立轴，不是一个可互换的枚举。Activation 轴使用实现名 `planned`、`provisioning`、`needs_resume`、`initialized` 与 `needs_manual_cleanup`：其中 `planned` 对应 policy 的 `planned`，`provisioning` 与可恢复的 `needs_resume` 都属于 policy 的 `applying`，`initialized` 表示部署层已完成并映射为最高 `configured`，`needs_manual_cleanup` 保持同名停止态。Verification 轴随后独立使用 `blocked_preflight`、`blocked_outcome`、`blocked_freshness`、`awaiting_verification` 与 `verified`；缺少 collector 或必需 observation 是 `awaiting_verification`，不能被 activation 状态提升为 `verified`。`configured`、`initialized` 和 `awaiting_verification` 绝不等于外部验收成功。恢复必须先重新发现远端仓库、初始提交和 provider 状态；不确定的外部结果不得触发破坏性补偿。

序列化边界采用默认拒绝：未知敏感字段、token、cookie、OAuth code、邮箱、业务正文和完整本地路径不得进入日志、fixture、回执或支持包。

## Bundle 和验收

Bundle v2 包含 schema/version、兼容范围、唯一 `agent-plugins` 上游与分发 provenance、release commit、asset/content SHA-256，以及 bootstrap 模板版本、内容摘要和三个参考仓固定提交。生产解析在任何 auth-dependent mutation 前验证完整性，并拒绝 sibling checkout、mutable ref 与旧的双组件 Bundle。

初始化计划包含安装 ID、目标 owner/name/visibility、模板版本/摘要、provider/profile 和待新增对象。所有目标仓与 provider 必须在第一次写入前完成只读 preflight。每创建一个仓库都立即持久化回执；若外部命令返回不确定结果，先结构化回读并进入 `needs_resume` 或 `needs_manual_cleanup`。卸载只撤销可证明由 AGX 新增的 provider 对象并删除本地 owned files，远端仓库始终保留。

验收 Issue 使用稳定的 installation marker；同一 installation ID 不得重复创建。部署声明必须显式选择 `github-delivery/v1` 或 `multica-execution/v1`，不能根据本机工具或已发现资源推断。统一 evaluator 只接受与 installation、deployment、subject、source、kind 和 freshness 全部匹配的类型化 observations。GitHub Profile 可独立达到 `verified`；Multica Profile 还必须满足 Workspace、Runtime、Agent 与完成的 Task 或 Run requirement。旧 receipt 可读但不推断 Profile，也不重写成新 `verified` receipt。

## Live Gate 状态

官方 Multica CLI v0.4.26 已完成一次认证 disposable Workspace、在线 Runtime、Issue 创建/分配、执行消息和清理的有边界 preflight。该证据允许开始实现结构化 CLI adapter，但不等于 AGX 安装已通过。资源操作、Task 取消语义以及完整 GitHub -> Multica -> Runtime 双回读仍须随实际命令逐项验证；fake contract test 只能验证本地设计，不能关闭这些 Gate。
