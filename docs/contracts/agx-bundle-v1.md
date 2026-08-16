# AGX Bundle v1 provenance contract

状态：`BLOCKED_UPSTREAM_RELEASE_METADATA`。`2233admin` 是该 Gate 的 Bundle/provenance decision owner，但截至 2026-08-16，`zaurakworks/agent-control` 与 `zaurakworks/agent-plugins` 均没有可读取的公开 Release 条目，因此没有真实 tag、commit、asset 或 digest 可写入 production Bundle。

## 生产输入

生产 Bundle 必须通过 [`agx-bundle.schema.json`](agx-bundle.schema.json) 验证，并为两个上游分别固定：

- GitHub Release tag；
- 该 Release 对应的 40 位 commit SHA；
- 资产名和 HTTPS 下载 URL；
- asset SHA-256 与解包后 content SHA-256；
- AGX 和官方 Multica CLI 的兼容范围。

生产模式只接受 `github_release` provenance，拒绝 sibling checkout、可变 branch/tag、内部目录和本地 Marketplace cache。任何 schema、repository、commit、asset、digest 或兼容性不匹配都必须在 auth-dependent mutation 之前停止。

## 开发与 fixture

`testdata/bundles/v1-synthetic-development.json` 是显式 `synthetic_test_only` development fixture：URL、release tag、commit 和 digest 全部是测试数据，不得用于下载、计划、apply 或 receipt 的 production provenance。development override 必须由调用者显式启用，并使 receipt 降级；它永远不能生成 `verified` 安装成功。

## Gate 关闭条件

在两个上游发布可公开读取的 immutable Release artifact 后，由 `2233admin` 记录每个实际 release tag、target commit、asset 名和两个 hash，再以独立 PR 加入 production fixture。schema 或 synthetic fixture 的通过不关闭这个 Gate，也不替代真实 Multica live evidence。
