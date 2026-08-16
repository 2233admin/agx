# D1 安全与凭据政策（审阅草案）

状态：`DRAFT_FOR_NAMED_SECURITY_OWNER_REVIEW`。本草案不关闭 #5；当前没有具名 security owner 或 release owner 的批准记录。

## 凭据

- GitHub 或 Multica credential 只能存入经批准的操作系统 credential store；store 不可用时停止，绝不退回明文文件、`.agx` 状态、日志或环境快照。
- 不要求用户粘贴长期 PAT。Device Flow 必须说明所请求 scope、可取消和超时；headless 输入仅可记录环境变量名，不能记录其值。
- token、cookie、OAuth code、邮箱、请求/响应业务正文、完整本地路径和未知敏感字段默认不得通过日志、计划、receipt、fixture 或 support bundle 的序列化边界。

## 外部写入与验证

- `status` 与 `diagnose` 只读；`verify` 要产生新的 acceptance 之前必须取得显式批准。
- `verified` 只能由匹配的 GitHub acceptance Issue 和 Multica Task/Runtime 双侧回读证据赋予。`configured`、queued、running 或局部资源创建完成都不是成功。
- 缺失官方 CLI、版本不兼容、认证失败、Workspace 歧义、Runtime 离线或 JSON 合同无效时，必须在 mutation 前停在 `blocked_preflight`。

## 恢复与清理

- `resume` 先发现外部状态，不能仅根据本地 journal 推定远端成功。
- rollback 仅针对最近的 AGX 事务；取消/终态不能可靠确认时停止补偿并进入 `needs_manual_cleanup`。
- uninstall 仅清理可由 installation ID、Bundle ID 与 fingerprint 证明为 AGX-owned 的资源；未知、用户-owned 资源和凭据一律保留并报告。

## 审阅缺口

具名 security owner 必须批准 credential/redaction/cleanup 规则；具名 release owner 必须批准平台标记和发布资格。fake fixture、mock adapter、旧项目测试或这份草案本身不得代替该批准，也不得代替真实 Multica 验收。
