# AGXCLI D1 Gate 与任务基线

状态以 GitHub Issue 为准。本文件只记录当前依赖和禁止跨越的 Gate。

| 顺序 | Issue | 类型 | 当前状态 | 依赖 |
| --- | --- | --- | --- | --- |
| 1 | #3 | 仓内规格/归属基线 | ready for review | — |
| 2 | #4 | Bundle v1 provenance Gate | production fixture ready；等待 #11 合并/回读 | #3 |
| 2 | #5 | credential/redaction/lifecycle/platform Gate | owner 已批准；等待 #3/#9 合并 | #3 |
| 3 | #12 | 官方 Multica CLI capability matrix 与 live fixture Gate | blocked：本机无 `multica` CLI、无认证 Workspace/Runtime/live transcript；必须同时取得官方机器可读 CLI 合同及 GitHub -> Multica -> Runtime 双回读证据 | #3、#4、#5 |
| 3 | #13 | main 保护与发布 review Gate | main 已保护；等待 #14 合并/回读 | #1、#3、#4、#5 |
| 4 | #6 | domain 与 diagnostic contract | blocked | #3、#4、#5 |
| 5 | #7 | 安全 CLI command skeleton | blocked | #3、#5、#6 |

## 后续 live 链

真实 golden path、D1 scope policy、官方 CLI transport、资源 adapter、acceptance Issue -> Task -> Runtime 双侧验收与双平台 release gate 必须按此顺序建立。官方 Multica CLI capability matrix 与 live GitHub -> Multica -> Runtime 双回读验收均由唯一的 #12 Gate 跟踪；main/release 保护由 #13/#14 跟踪。它们共同依赖真实官方 CLI、认证 disposable Workspace、online Runtime 与 disposable GitHub repo；在这些输入出现前保持 `BLOCKED-LIVE-MULTICA`。

## 关闭规则

- Draft policy、synthetic fixture、fake adapter 或旧项目测试不能关闭安全、供应链或 live Gate。
- 无稳定机器可读官方 CLI 合同的能力必须在写入前拒绝，而不是猜测或解析人类输出。
- 每一个实现变更需要独立 Issue、分支、本地验证、push 和 Draft PR；不得直接推送 `main`，不得自行合并或绕过保护规则。
- 任何 Release 在 D1 双平台真实验收完成前必须是 preview，且不得宣称安装成功。
