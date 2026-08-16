# D1 平台与发布政策（审阅草案）

状态：`APPROVED_BY_2233ADMIN_PENDING_MERGE`。`2233admin` 已获授权并以 release owner 身份批准本政策；当前没有真实双平台 live evidence，因此此文不能授权发布为 certified。

## 候选平台

- Windows 11 x64
- Ubuntu 24.04 x64

候选平台在完成下述真实认证前必须标为 `preview`。其他平台也只能标为 preview，且不能借此扩张 D1 支持承诺。

## Certified 前提

同一已冻结合同必须在两种候选平台上各自留下脱敏证据，至少包括 clean install、repeat no-op、interrupted resume、permission denial、Multica unavailable、Runtime offline、Bundle mismatch、drift conflict、Task manual cleanup 和 support-bundle redaction。每次成功都必须满足 GitHub -> Multica Task -> Runtime -> GitHub/Multica 双侧回读。

认证环境需要官方 Multica CLI、认证的 disposable Workspace、在线 Runtime 和 disposable GitHub repository。当前这些 live 输入不可用，因此本项目没有 D1 certified release。

## 发布约束

发布 artifact 必须包含版本、兼容性范围和 SHA-256。checksum/provenance 错误必须在写入前阻断。不得自动升级二进制，不得部署或升级 Multica 服务端，不得将 fake 结果、文档审批或开发 override 作为 certified 证据。
