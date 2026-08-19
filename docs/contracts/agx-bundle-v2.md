# AGX Bundle v2 单一 Plugin 源契约

状态：`IMPLEMENTED_PENDING_MERGE`。`2233admin` 是 Bundle/provenance decision owner。Bundle v2 只安装一个 Plugin 源；`agent-control`、`agent-contracts` 是初始化阶段从版本化模板创建的部署仓库，不是预先存在的 Release 组件。Plugin Source 是 `zaurakworks/agent-system`；生产输入是 `2233admin` 的 immutable Release。AGX 不跟随 Source git `main`。

## 生产输入

生产 Bundle 必须通过 [`agx-bundle.schema.json`](agx-bundle.schema.json) 验证，并固定唯一的 `sources.agent_plugins`：

- 当前生产 Release 的历史上游身份固定为 `zaurakworks/agent-plugins`；
- 分发身份固定为 `2233admin/agent-plugins`；
- GitHub Release tag、40 位 commit SHA、资产名与分发仓库的 Release HTTPS URL；
- asset SHA-256 与 gzip 解压后的 tar 字节流 content SHA-256；
- AGX 兼容范围。

生产下载继续使用 `2233admin/agent-plugins` 的 immutable prerelease `agx-plugins-20260819.1`：commit `ef07a9fd530ebac1b85eb5b9511ebd6742d743ee`、asset `agent-plugins-agx-plugins-20260819.1.tar.gz`、asset SHA-256 `d1ae80cebb7eb84c53e8d7f5b8af2f60786721219b492b5a8975e66442fbc97e`、content SHA-256 `c752241575cabe79018c9dc990d2425e1ecd6ac03c88799050fd5b579f32aa21`。在带 digest 的新 Distribution Release 出现前，不得把未打 tag 的 `agent-system` main SHA 或已改名的 `zaurakworks/agent-control` 写成生产 pin。

生产模式只接受 `github_release` provenance，且 URL 必须精确落在固定分发仓库、Release tag 与 asset 名组合出的路径。生产拒绝 sibling checkout、可变 branch/tag、本地路径、旧 `artifacts` 双组件结构和任何 `agent_control` source。Multica 不属于 Bundle v2 compatibility；出现 `multica_cli` 会按未知字段拒绝。

## 模板元数据

`templates` 记录初始化模板集的版本、确定性内容 SHA-256，以及提炼模板时只读参考的三个仓库和精确 head：

- `zaurakworks/agent-plugins` @ `ad07742ade0f0039ed1df1a9262e8f087117fca0`；
- `zaurakworks/agent-system` @ `b0e6e0e8244ef518f671e2326745cd67c6d2307a`（改名后仍可寻址的历史蒸馏快照，不是 untagged main）；
- `zaurakworks/agent-contracts` @ `5bb8ea0b54f063b0758c294b73ea270ba69322d2`。

这些 reference 只解释模板来源与取舍，不把部署仓 `agent-control` / `agent-contracts` 或 Source 整树变成安装组件。模板集版本是 `bootstrap-20260819.1`，未渲染 embedded source manifest 的固定 SHA-256 是 `6e5eee0139001ed29fdf7c3689881fd5af544d86e1a99ed67e88274921555d65`；部署参数产生的 rendered tree digest 由初始化回执另行记录。

## 安装回执

Apply 先分别验证压缩资产和 gzip 解压后的 tar 字节流摘要，再只解包 `components/agent-plugins`。`agx.receipt/v2` 必须恰好记录一个 `agent-plugins` component，其 `repository` 为上游身份、`distribution_repository` 为分发身份；所有 owned file 必须位于该组件。`owned_file_sha256` 与 owned file 一一绑定，使 Status、重复 Apply 与 Uninstall 能拒绝内容篡改。回执同时记录 `template_version` 与 `template_content_sha256`，供后续初始化计划和漂移检查使用。

旧 `agx.bundle/v1`、旧 `agx.receipt/v1`、双组件回执、`components/agent-control` owned file、身份或 digest 不匹配都拒绝。Status 与 Uninstall 仍逐段检查真实目录和 regular file，不跟随 symlink/junction，也不删除回执无法证明归属的文件。

## 开发与 fixture

[`testdata/bundles/v2-synthetic-development.json`](../../testdata/bundles/v2-synthetic-development.json) 是显式 `synthetic_test_only` development fixture。development override 必须显式为 `true`；它不能生成 `verified`。生产 fixture 是 [`testdata/bundles/v2-production-agx-plugins-20260819.1.json`](../../testdata/bundles/v2-production-agx-plugins-20260819.1.json)。
