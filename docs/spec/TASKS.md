# AGXCLI D1 Gate 与任务基线

状态以 GitHub Issue 为准。本文件只记录当前依赖和禁止跨越的 Gate。

| 顺序 | Issue | 类型 | 当前状态 | 依赖 |
| --- | --- | --- | --- | --- |
| 1 | #3 | 仓内规格/归属基线 | ready for review | — |
| 2 | #4 | Bundle v1 provenance Gate | production fixture ready；等待 #11 合并/回读 | #3 |
| 2 | #5 | credential/redaction/lifecycle/platform Gate | owner 已批准；等待 #3/#9 合并 | #3 |
| 3 | #12 | 官方 Multica CLI capability matrix 与 live fixture Gate | bounded live preflight passed；等待真实 AGX adapter 实现逐命令验收 | #3、#4、#5 |
| 3 | #13 | main 保护与发布 Gate | main 已保护；单维护者以 required CI 后自合并 | #1、#3、#4、#5 |
| 4 | #6 | domain 与 diagnostic contract | implemented；由 #27 集成 | #3、#4、#5 |
| 5 | #7 | 安全 CLI command skeleton | implemented；由 #27 集成 | #3、#5、#6 |
| 6 | #33 | 单一插件源、bootstrap 模板与部署仓初始化 | in progress；由 Draft PR #34 集成 | #9、#11、#27 |

## 后续 live 链

当前先关闭 #33 的本地安装、模板渲染、目标仓创建、provider 激活和可恢复回执闭环。真实 golden path、官方 CLI transport、资源 adapter、acceptance Issue -> Task -> Runtime 双侧验收与双平台 release gate 仍按此顺序建立。#12 已取得 bounded live preflight，后续每个 AGX adapter 命令仍须用结构化官方 CLI 行为逐项验收。

## 关闭规则

- Draft policy、synthetic fixture、fake adapter 或旧项目测试不能关闭安全、供应链或 live Gate。
- 无稳定机器可读官方 CLI 合同的能力必须在写入前拒绝，而不是猜测或解析人类输出。
- 每个产品变更需要有验收标准的 Issue、分支、本地验证和 PR；相关的已完成工作可以合并集成。单维护者可在全部 required CI 通过后自合并，但不得直接推送或绕过保护规则。
- 任何 Release 在 D1 双平台真实验收完成前必须是 preview，且不得宣称安装成功。
