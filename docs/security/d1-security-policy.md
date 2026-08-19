# D1 安全与凭据政策（审阅草案）

状态：`APPROVED_BY_2233ADMIN_PENDING_MERGE`。`2233admin` 已获授权并以 security/release owner 身份批准本政策；#5 仍等待其依赖的 #3 基线和本政策合并。此批准不构成真实 Multica 验收证据。

## 凭据

- GitHub 或 Multica credential 只能存入经批准的操作系统 credential store；store 不可用时停止，绝不退回明文文件、`.agx` 状态、日志或环境快照。
- 不要求用户粘贴长期 PAT。Device Flow 必须说明所请求 scope、可取消和超时；headless 输入仅可记录环境变量名，不能记录其值。
- token、cookie、OAuth code、邮箱、请求/响应业务正文、完整本地路径和未知敏感字段默认不得通过日志、计划、receipt、fixture 或 support bundle 的序列化边界。

## 外部写入与验证

- `status` 与 `diagnose` 只读；`verify` 要产生新的 acceptance 之前必须取得显式批准。
- `verified` 只能由操作者显式选择的版本化 Evidence Profile 的全部必需外部回读证据赋予：`github-delivery/v1` 要求完整、绑定一致且新鲜的 GitHub 交付证据；`multica-execution/v1` 在同一 GitHub 基线之外还要求匹配的 Multica Workspace、Runtime、Agent 与 Task/Run 证据。`configured`、queued、running、单个信号或局部资源创建完成都不是成功。
- 缺失官方 CLI、版本不兼容、认证失败、Workspace 歧义、Runtime 离线或 JSON 合同无效时，必须在 mutation 前停在 `blocked_preflight`。

## 恢复与清理

- `resume` 先发现外部状态，不能仅根据本地 journal 推定远端成功。
- rollback 仅针对最近的 AGX 事务；取消/终态不能可靠确认时停止补偿并进入 `needs_manual_cleanup`。
- uninstall 仅清理可由 installation ID、Bundle ID 与 fingerprint 证明为 AGX-owned 的资源；未知、用户-owned 资源和凭据一律保留并报告。

## 审阅缺口

`2233admin` 已批准 credential/redaction/cleanup 规则及平台标记/发布资格。fake fixture、mock adapter、旧项目测试或本政策本身不得代替所选 Evidence Profile 要求的真实外部验收；选择 `multica-execution/v1` 时，必须包含真实 Multica 回读。
