# Codex 云端能力兼容性跟踪

## 当前实现与验证边界

本次范围为已确认的非语音 Codex 云端服务。参考上游 b348fc26674189f758d5941cdab3f78f258b2aa7（cloud 专用跟踪常量在 src/upstream.ts）；原 Provider 协议基线仍单独保留。四个工具是普通 DSH function 工具，不依赖专用模式，不覆盖现有工具。

| 能力 | 当前实现 | 验证与来源 |
| --- | --- | --- |
| 文本/推理、图像输入 | 保留 Standard/Lite 和 HTTP/WebSocket | 原有回归；responses.ts、native-http.ts |
| 网页/图片搜索与浏览查询 | codex_web 覆盖十种 commands、模式/过滤/位置/上下文；账号/会话绑定引用 | cloud-http/search/context/web-tool 及真实 ToolRuntime mock 集成；上游 codex-api/src/search.rs、endpoint/search.rs |
| 搜索图片、PDF 截图 | 已知内联 input_image 进入附件；远程 URL 保留链接和不可提取说明，未知 DTO 保留有界 opaque results | 上游 protocol/src/models.rs；公开 DSH web 暂无二进制下载边界；未把链接等同已下载图片 |
| 图像生成、编辑 | JSON generations/edits，全部 1–4 输出；1–5 输入；原图与预览分开 | cloud-images/media/tools；实际 LocalAttachmentStore + sharp 解码/EXIF/字节保真测试；上游 codex-api/src/images.rs、endpoint/images.rs |
| 显式识图 | 无递归工具的单次 Responses/Lite；original/high 回退、Lite 省略，实际尺寸与 usage | cloud-vision/tools 与流/注册测试；上游 core/src/client_common.rs、protocol/src/openai_models.rs |
| 实时语音 | 按用户要求排除 | 不注册语音工具，不宣称支持 |

生成/编辑原图仅通过调用者公开 fs/shell/sandboxPolicy 保存到工作区 .dsh/codex-images；附件通过公开 AttachmentStore 完整解码。测试包括实际文件写入及权限参数传递，mock 参数测试不等于真实沙箱强制验证。Code Mode 同一程序内已返回图片有短期会话缓存，历史变动后依赖已归档可见附件；不会接受其他会话的任意 ID。

真实账号验证（2026-09-10）：网页搜索、基于返回 ref 的 open、图片搜索、一次低质量单图生成、一次对生成图编辑、gpt-5.5 original 识图均成功。共 8/12 次请求（包括一次目录请求、一次图片搜索结构核对），生成/编辑各仅一次。图片搜索返回文本中的 11 个图片引用和 22 个 URL，没有二进制附件；保留这些来源不等于内联图片已下载。生成原图实际为 1254×1254（服务端未严格采用请求的 1024×1024），识图按该实际尺寸发送；返回 usage 为 inputTokens=1956、outputTokens=19。只记录摘要与 SHA-256，不保存账号、token 或完整图片/提示。

本地 pnpm build、22 文件/365 项测试、pnpm pack 与 git diff --check 均通过；安装包包含八个新模块与声明。详细不可变 evidence、脱敏 live 结果和产物见同工作区 .runbook/runs/codex-cloud-capabilities。此结果证明本次当前账号的可用性，不保证所有账号和未来内部 endpoint。当前常驻 GUI 未重启，也未安装替换；详细用法见 README 的“云端搜索和图片工具”。

## 初次广义审查（历史记录，以下状态与建议不再代表当前实现或执行范围）

## 本次核对基线

- 插件版本：0.9.0。
- 插件声明跟踪：`ddf04ad26789d040f9ef6a96736f76602e35a6cc`（`src/upstream.ts:3`）。
- 本地 `../codex` 已 fast-forward 至 `b348fc26674189f758d5941cdab3f78f258b2aa7`，与本次 fetch 的 `origin/main` 一致，增加 272 个提交，工作树干净。
- 原 checkout 为 sparse checkout；为核对完整工具类型，追加了 `codex-rs/tools`。
- 验证：`pnpm test`，14 个测试文件、233 项测试全部通过，包括生成产物与新鲜 TypeScript 编译一致性检查。未使用真实账号执行新增能力的端到端验证。
- 本次是更新上游后的差异检查；没有提升插件的 TRACKED_CODEX_COMMIT，也没有宣称已完成新版本兼容。

## 结论

当前插件能够传送 DSH 注册的普通 JSON function 工具，但不能承诺具备 Codex 的完整工具能力。上游 `codex-rs/tools/src/tool_spec.rs:22` 声明 function、namespace、tool_search、web_search、custom 五种协议类型；插件的 `src/responses.ts:69` 只生成 function，Lite 路径只额外包装固定的 functions namespace。这几种工具声明在本次 272 个提交之前就已存在：该区间没有修改上游 tool_spec.rs。

Codex 本地工具由其 runtime 执行；OAuth 登录和 Responses 适配不会自动安装这些执行器。DSH 可以提供类似功能，但必须分别核对参数、执行、结果、恢复和权限语义，不能仅按工具名称判断一致。上游工具也受模型、配置、平台、功能开关和账号可用性约束，并非每个会话全部启用。

## 协议能力清单

| 能力 | 当前状态与证据 | 补齐方向 |
| --- | --- | --- |
| JSON function 调用、参数流、工具结果 | 已实现；`src/responses.ts:69`、`:503` | 保持请求→流解析→执行→结果→续轮覆盖 |
| 图片输入及图片工具结果 | 已实现；`src/responses.ts:50`、`:57` | 仍缺上游 image detail 选择，不能等同完整图像能力 |
| Freeform / grammar / custom | 缺失；上游 `core/src/tools/handlers/apply_patch_spec.rs:18` 和 `core/src/tools/code_mode/execute_spec.rs:26` 使用 custom；插件不会声明此类型，`:593` 拒绝其 completed item | 扩展工具 schema、原始字符串参数、custom_tool_call/output、流和 replay，并接实际执行器 |
| 通用 namespace | 部分支持；Lite 固定 functions；`:526` 保存返回 namespace，但 `:515`/`:521` 向执行层只输出裸 name | 保留 namespace 身份和描述，支持同名工具隔离及普通/Lite 请求 |
| 延迟发现 tool_search | 缺失原生协议；上游 `core/src/tools/handlers/tool_search_spec.rs:97` 使用 execution=client | 实现 defer_loading、搜索/加载结果、additional_tools、后续工具可见性；普通同名 function 不等同此协议 |
| OpenAI 托管 web_search | 缺失；上游 `core/src/tools/hosted_spec.rs:14` 配置 cached/indexed/live、域名/位置/内容类型；插件只声明 functions，拒绝 web_search_call completed item | 显式配置托管工具、事件、引用/来源和续轮；DSH 自有搜索仅为另一种实现 |
| 消息 phase 和扩展元数据 | 未完整保存；`src/replay.ts:10` 的 message 只有 id/blocks；上游 `protocol/src/models.rs:1008` 包含 phase 和 internal_chat_message_metadata_passthrough | 有界保留所需字段并明确 UI 与历史恢复语义 |
| 其他 response items | 插件仅接受 function_call/message/reasoning，其余在 `src/responses.ts:593` 报 UNSUPPORTED | 按实际声明的能力逐类实现，不能仅忽略未知项假装支持 |
| HTTP/SSE、WebSocket v2、加密 reasoning replay | 已有实现和测试（native-http、native-websocket、replay suites） | 现有测试通过不代表新增工具类型已覆盖 |

上游路径在表中均相对于 `../codex/codex-rs/`。

## DSH 宿主边界

已检查当前安装的 `@deepseek-ai/dsh-llm/lib/types/types.d.ts:325`：ToolSchema 仅有 name、description、parameters；GenerateOptions.tools 是该类型数组。通用 namespace、freeform、托管工具和 deferred loading 没有直接表达位置。因此完整支持需要 DSH 的公共工具/LLM 类型与执行链配合，或先设计明确的 provider 扩展接口；只修改此插件的一处 tools JSON 不足以完成。

需另外核对的执行能力：

- Codex exec_command/write_stdin 的交互进程、PTY、环境选择，与 DSH bash/job 工具的差异。
- apply_patch 的 grammar 和补丁执行，与 DSH edit/write 的差异。
- Code Mode 的原始代码、yield/wait、工具调用追踪与 DSH run_code 的差异。
- MCP/Apps 的发现、namespace、授权、工具结果元数据与 DSH MCP 插件的差异。
- 多 agent、异步用户输入、上下文切换/余量工具、图像生成等是否由目标 DSH profile 配齐。

这些项目尚未逐项做运行时等价验证，不能从本次协议审查推出缺失于所有 DSH profile，亦不能标记为已对齐。上游注册入口见 `core/src/tools/spec_plan.rs`。

## 本次上游增量中相关变化

- `core/src/client_common.rs` 新增基于模型能力的 image detail 规范化：Lite 清除 detail；不支持 original 的普通模型回退默认 detail。插件当前统一不发送 detail，未表达该能力。
- `protocol/src/models/executed_tool_calls.rs` 扩展 tool_result_metadata；插件没有对应执行追踪元数据。
- `protocol/src/openai_models/reasoning_effort.rs` 将 Ultra/Persistent 归一化集中到模型类型；插件已实现相似映射，需继续用 fixtures 校验，不能把源码重构直接认定成缺功能。
- `codex-api` 删除旧 compaction endpoint 实现，不能默认把旧 /compact 接入方式作为升级方案；DSH 当前使用辅助生成压缩，属于单独的运行时策略。

## 测试盲区与后续复现

现有测试集中于 function 调用。独立源码复核还发现以下待复现边界，尚不作为已验证的线上故障：

- `src/responses.ts:597` 不从 response.completed.response.output 提取输出，仅依赖前面的流事件；需确认目标服务是否可能只发送终态内嵌输出。
- 只有 encrypted reasoning 且 summary 为空时，当前没有可见 block，会走 EMPTY_RESPONSE；现有相关测试仅检查 finish 存在，未验证成功/错误语义。
- 重复 item.added/item.done 缺少明确重复调用防护；需用真实结构的事件回放验证是否可能重复分发。
- namespace 冲突、custom/builtin completed item、refusal 内容、复杂 schema 等缺少对应的兼容性行为覆盖。

## 建议推进与验收

1. 优先处理现有支持路径的保真性：phase、namespace 路由身份、相关 replay 元数据；增加 HTTP/SSE 与 WebSocket 的多轮恢复用例。
2. 设计宿主工具 schema 扩展，接通 custom/freeform 和通用 namespace；以真实 apply_patch/code-mode 调用、同名 namespace 隔离及重启恢复作验收。
3. 接通工具发现与托管 web_search；验证延迟加载、引用/来源、失败/取消和后续轮次。
4. 对目标 DSH profile 建立执行能力矩阵，再处理交互 shell、MCP/Apps、多 agent、图像生成等 runtime 项。
5. 新增上游 fixture/能力矩阵检查；每次升级记录审查过的 commit 和尚未支持项，行为测试通过后再提升 src/upstream.ts 的兼容基线。

测试应覆盖有效请求和两种传输下的完整调用生命周期，而不仅是静态工具名称清单。未知能力仍应明确报错，不能丢弃事件后把测试标记为兼容。
