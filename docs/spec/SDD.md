# AGXCLI D1 软件设计基线

状态：设计合同。适配器的真实能力仅在 live Gate 取得证据后才能声明支持。

## 分层

1. `cmd/agx` 负责解析、呈现和稳定退出码；它不拥有状态机，也不直接进行外部写入。
2. domain 定义 DesiredState、ObservedState、Plan、Step、Receipt、Verification、Diagnostic、installation ID、ownership、desired hash、幂等策略和补偿类别。
3. plan/saga/journal 基于 domain 生成可重复的计划、执行已批准步骤、先发现后恢复，并在不确定外部结果时停止或进入 `needs_manual_cleanup`。
4. GitHub adapter 只在批准后的 acceptance 工作中创建/回读受 installation ID 标记的 Issue。
5. Multica adapter 只能包装版本化官方 CLI 的机器可读接口；必须使用结构化参数、超时、exit-code 捕获、JSON schema 验证和脱敏。CLI 缺失、版本不兼容、认证或 Workspace 歧义必须在写入前报告 `blocked_preflight`。

## 状态和安全语义

允许状态至少包括 `planned`、`applying`、`configured`、`blocked_preflight`、`awaiting_verification`、`verified` 与 `needs_manual_cleanup`。`configured` 和 `awaiting_verification` 绝不等于成功。`resume` 必须先重新发现外部状态；当 Task 取消/终态不能可靠确认时，不得继续破坏性补偿。

序列化边界采用默认拒绝：未知敏感字段、token、cookie、OAuth code、邮箱、业务正文和完整本地路径不得进入日志、fixture、回执或支持包。

## Bundle 和验收

Bundle v1 应包含 schema/version、兼容范围、control/plugins artifact pin、release commit、SHA-256/content hash、资源标识、preflight/acceptance probes、迁移与回退信息。生产解析在任何 auth-dependent mutation 前验证完整性，并拒绝 sibling checkout 和 mutable ref。

验收 Issue 使用稳定的 installation marker；同一 installation ID 不得重复创建。只有无害 GitHub acceptance Issue 触发的 Multica Task 已由 Runtime 完成，且 GitHub/Multica 的回读证据一致时，Receipt 才能写为 `verified`。

## 未满足的 live Gate

当前没有可用于该合同的真实官方 Multica CLI、认证 disposable Workspace、Runtime 或 live fixture。因此 adapter、资源操作、Task 取消语义和端到端验收均为 blocked；fake contract test 只能验证本地设计，不能关闭 Gate。
