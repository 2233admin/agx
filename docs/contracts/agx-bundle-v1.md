# AGX Bundle v1 provenance contract

状态：`PRODUCTION_FIXTURE_READY_PENDING_MERGE`。`2233admin` 是 Bundle/provenance decision owner。两个 `2233admin` fork 已发布受保护的 immutable prerelease，因而 production fixture 已有真实 tag、commit、asset 与 digest；这不改变 `zaurakworks` 两个上游的独立归属，也不构成 Multica live evidence。

## 生产输入

生产 Bundle 必须通过 [`agx-bundle.schema.json`](agx-bundle.schema.json) 验证，并从受信的 `2233admin` fork Release 为两个上游组件分别固定：

- GitHub Release tag；
- 该 Release 对应的 40 位 commit SHA；
- 资产名和受信 fork 的 GitHub Release HTTPS 下载 URL；
- asset SHA-256 与解包后 content SHA-256；
- AGX 和官方 Multica CLI 的兼容范围。

生产模式只接受 `github_release` provenance，且 schema 必须把 artifact URL 限定到受信 fork 的 GitHub Release 下载路径。生产拒绝 sibling checkout、可变 branch/tag、内部目录和本地 Marketplace cache。任何 schema、repository、commit、asset、digest 或兼容性不匹配都必须在 auth-dependent mutation 之前停止。

## 开发与 fixture

`testdata/bundles/v1-synthetic-development.json` 是显式 `synthetic_test_only` development fixture：URL、release tag、commit 和 digest 全部是测试数据，不得用于下载、计划、apply 或 receipt 的 production provenance。development override 必须由调用者显式启用，并使 receipt 降级；它永远不能生成 `verified` 安装成功。

## 已记录的 production fixture

[`testdata/bundles/v1-production-agx-bootstrap-20260816.1.json`](../../testdata/bundles/v1-production-agx-bootstrap-20260816.1.json) 固定了以下 prerelease：

- `2233admin/agent-control` 的 `agx-bootstrap-20260816.1`，commit `37adcc3c011ab7a1720cdcc68c81843173f04ac3`；
- `2233admin/agent-plugins` 的 `agx-bootstrap-20260816.1`，commit `eb10f7f14cc05b70b6c27a121c6f72d1b3b9edb8`。

两条 tag 均由 active、无 bypass 的 tag ruleset 保护，禁止 update 与 deletion。#11 合并并经回读后，#4 的 production provenance Gate 才可关闭。schema 或 synthetic fixture 的通过不替代真实 Multica live evidence。
