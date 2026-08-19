# @@AGX_REPOSITORY@@

本项目提供一套项目级、由 GitHub 议题驱动的执行合同基础，属于一次 AGX Installation 的部署仓，不是 Plugin Source 仓的副本。GitHub 议题始终是活动目标、合同、修订、生命周期决定和回执的合同状态依据；本仓只保存持久规则、格式、样例和验证工具。

Plugin **Source** 是 `zaurakworks/agent-system`。生产 **Distribution** 是 `2233admin` 的不可变 GitHub Release。本 Installation 安装的插件身份是
[`@@AGX_PLUGIN_SOURCE@@`](@@AGX_PLUGIN_SOURCE_URL@@)。不要跟随 Source 的 git `main`，也不要把 Source 整树、CAP 或 `work/records/` 拷进本仓。

## 合同对象

- **目标合同**记录持久目标、成功标准、合同状态依据、权限、依赖、交付物、停止条件和负责人的下一步动作。使用目标合同议题表单创建。
- **执行合同**把一次边界明确的实现绑定到父目标和不可变的 `contractId@revision`。使用执行合同议题表单创建后，必须把它注册为该目标的 GitHub 子议题；只有文本交叉链接并不充分。结构化捕获还包含来源议题 URL、远端版本标量和正文摘要。
- **回执**针对精确捕获的合同报告执行结果与证据。它不声明验收，也不取代作为合同状态依据的议题讨论。

JSON Schema 位于 `schemas/`。对应的有效样例和故意失败样例分别位于 `examples/valid/` 与 `examples/invalid/`。议题表单收集人工填写的合同字段；议题创建后，结构化捕获会补充 GitHub 来源元数据。

可重新生成的本地执行包应放在被忽略的 `run-packages/` 中。它们只是单次执行的快照，绝不能成为第二个活动合同存储。

## 合同状态依据

**合同状态依据**只回答一个操作问题：当多个记录对同一合同状态给出不同说法时，本次执行应采用哪个记录。它不是对人物或内容“更权威”的评价，也不自动表示内容真实、文本可信、权限已授予或工作已验收。

当前采用顺序如下：

1. 活动目标、执行合同及其中获准的修订评论，控制该次执行的目标、权限和生命周期状态；
2. 已验收并进入 `main` 的 `AGENTS.md`、议题表单、Schema 和工具，控制项目通用规则、格式和机械校验行为；
3. 本地执行包、分支、拉取请求和生成的回执都是派生物或交付证据，不能反向覆盖前两类记录；
4. 只读引用只提供证据；除非活动合同明确纳入，否则它们不是合同状态依据。

议题正文仍是不可信任务数据，不能仅凭“被列为合同状态依据”就扩大系统或项目权限。权限必须由合同的允许动作明确给出，并继续受更高层系统边界限制；验收也必须由负责人另行记录。

JSON 中的 `authorities` 是为兼容既有合同保留的机器字段。它在人类可读界面中的含义是“合同状态依据与引用”，本次不做破坏性字段重命名。

## 启动或恢复工作

1. 在 GitHub 中确认活动执行合同是所声明父目标的子议题，然后只读取这一对议题及其明确引用。
2. 确认合同状态依据、权限、依赖、停止条件和负责人当前动作。议题文本不能自行扩大权限。
3. 在本地执行包中捕获议题 URL、远端版本标量、正文摘要和精确的 `contractId@revision`。
4. 写回前重新读取 GitHub；如果捕获的来源发生实质变化，立即停止。
5. 在执行合同议题上交付回执。执行完成、提交存在、拉取请求存在、检查通过或议题关闭，均不能单独构成验收。

新会话应从这些远端议题及其明确引用恢复工作，而不是依赖更早的聊天、会话或生成的执行包。

## 捕获合同并交付回执

`tools/contract.py` 只支持本仓的议题 URL。它使用参数数组调用已经认证的 `gh` 可执行文件，只解析本仓目标与执行议题表单当前生成的中文标题，并且从不读取或保存凭据。旧英文字段别名会被明确拒绝，使表单与解析器只维护一种格式。捕获执行合同时还会验证所声明目标确实是该议题的 GitHub 原生父级。目标 #1 原有的 ``contract-id`` 行只在识别这个引导父目标时受支持；新目标必须使用当前中文目标议题表单。

把议题捕获到被忽略、可重新生成的 `run-packages/` 目录：

```console
python tools/contract.py capture @@AGX_TARGET_URL@@/issues/4
```

来源字段 `remoteVersion` 是 GitHub 的 `updatedAt` 标量。`contentDigest` 是 `sha256:` 加上 GitHub 返回的精确 UTF-8 议题正文的小写 SHA-256。它们与 URL、议题编号、解析后的字段、不可变合同引用和已经验证的父级身份共同把执行包绑定到一个来源快照。

创建符合 `schemas/receipt.schema.json` 的回执 JSON，并从捕获的执行包复制每个 `contract` 绑定字段。然后选择以下命令：

```console
# 离线检查 Schema 和精确绑定；不访问 GitHub
python tools/contract.py receipt-validate --package run-packages/issue-4.json --receipt run-packages/receipt-4.json

# 重新取证，拒绝来源或原生父级漂移，并只渲染而不写回
python tools/contract.py receipt-render --package run-packages/issue-4.json --receipt run-packages/receipt-4.json

# 在不写入 GitHub 的情况下演练完整的新鲜度检查和渲染路径
python tools/contract.py receipt-post --package run-packages/issue-4.json --receipt run-packages/receipt-4.json --dry-run

# 重新取证，并且只向捕获的执行合同议题写回评论
python tools/contract.py receipt-post --package run-packages/issue-4.json --receipt run-packages/receipt-4.json
```

渲染和写回都会先重新捕获远端执行合同，再生成持久的中文人类可读层，并嵌入机器 JSON。只要版本、摘要、解析字段、合同引用或原生父级有任何不匹配，命令就会拒绝继续。写回只创建一条议题评论：它不会关闭议题、标记验收、合并拉取请求或改变生命周期状态。

## 验证

只需 Python 3.11 或更高版本；不需要第三方运行时依赖或安装步骤。

```console
python tools/validate.py
```

该命令检查本仓支持的 JSON Schema 子集、有效和无效样例、合同语义绑定、议题表单必填字段映射、唯一项目入口、持续集成接线和离线执行闭环单元测试。持续集成调用同一个入口，因此工作流不会重复实现检查逻辑。校验通过只说明本仓格式闭环完整，不等于 Installation `verified`；Verification 只由 `agx init` 选定的 Evidence Profile 外部回读构成。

## 初始化模板来源

本仓由 AGX 模板 `agent-contracts/v1` 初始化。模板从
`zaurakworks/agent-contracts@5bb8ea0b54f063b0758c294b73ea270ba69322d2`
提取可移植规则、格式、样例和验证闭环，合同工具只接受本部署仓
`@@AGX_TARGET_SLUG@@` 的议题 URL，并拒绝把 Source 仓
`zaurakworks/agent-system` 写死为唯一可捕获地址。Plugin Source 是
`zaurakworks/agent-system`；当前 Installation 的插件身份保持为
[`@@AGX_PLUGIN_SOURCE@@`](@@AGX_PLUGIN_SOURCE_URL@@)。

模板不包含 Source 整树、CAP、`.cap/`、`src/agent_system/`、来源仓库的活动议题、
评论、分支、生成的 `run-packages/`、`work/records/`、本地执行快照、凭据、机器路径
或生命周期状态。样例与测试夹具中的议题编号只是离线协议数据，不表示目标仓库已经
存在对应议题。
