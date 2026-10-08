# Codex 云端能力兼容性跟踪

## 重试、消息阶段与 Standard 指令对齐（Unreleased）

本节记录对 `ea27864f` 的三项增量适配，取代下方 Retry-After、phase 和 Standard 指令位置的历史待办；其余工作仍独立跟踪。

- Standard 基础指令改为 input 首部的 developer message，和 Lite 共用稳定 UUID 与 `model.base_instructions` metadata 构造。Standard 顶层 tools、并行工具与 reasoning 参数保留各自协议；Lite 的工具前缀及目录模板/DSH 指令组合保持独立。回归验证相同指令保持 WS 前缀复用，改变指令会触发完整请求，HTTP 历史、图片、工具输出和加密 reasoning 顺序不变。
- 消息 phase 已接收并保留 commentary / partial_answer / final_answer，通过 v1 描述符的可选字段持久化再回放，并让 WS 复用比较使用同一有效 phase。added-only 的 phase 保留到 done，done 的显式 phase 优先；流中的 null/缺失值表示未提供，非法枚举拒绝。测试覆盖 JSON 保存/恢复、分叉和重启的请求构造、真实传输类的增量匹配与 phase 改变后完整重发。缺少 phase 的旧会话可读；旧插件的严格字段校验无法读取含 phase 的新描述符，降级时需考虑这一限制。
- Retry-After 共用秒数/HTTP-date 解析，支持 JSON 数字值，嵌套错误 headers 优先；保留单次收到建议的单调时钟截止时间，不用本地退避上限截短服务端等待。HTTP 读取错误正文及其超时不会重置或丢弃等待，WS 最后一次失败后切换 HTTP 也遵守剩余等待。长等待分段使用 Node timer，仍可取消。宿主 `LlmError` 只公开正数 duration，无法跨宿主持久化表达单调时钟 deadline；本插件默认 normal 重试策略在宿主等待超上限时交还错误，不会提前重试。宿主另行配置的 always 策略可能忽略长等待，不属于本次插件内改动。

验证：`npm run build`、`npm test`（27 文件 / 511 项）、`npm run typecheck`、`git diff --check`、`npm pack --dry-run --ignore-scripts` 均通过；所有生成模块与新鲜编译一致，新 retry-after 模块已加入打包清单。独立审查发现的非法日期归一化问题已修复，并加入内层非法日期回退外层有效等待的回归。本轮为源码、模拟传输与 loopback 验证，未执行线上推理、发布、替换 hu profile 或重启 GUI。

## GPT-6.1 Sol 增量对齐（Unreleased，2026-10-08）

`../codex` 已 fast-forward 到 `ea27864f99f0b086cec2f9f0251b7190fb9844f1`（本次获取的 origin/main），工作树干净。此轮针对模型发现与 Lite 路由，不宣称完整运行时对齐，原 Provider/cloud 跟踪提交保持不变。

### 已确认的缺失原因与修复

对同一当前账号执行只读线上目录请求（未调用推理、未记录凭据）：

| client_version | originator | HTTP | 返回目录 |
| --- | --- | --- | --- |
| 0.153.4 | dsh | 200 | 不含 gpt-6-sol / gpt-6.1-sol |
| 0.155.0 | dsh | 200 | 含 gpt-6-sol，不含 gpt-6.1-sol |
| 0.162.0 | dsh | 200 | 含 gpt-6.1-sol，visibility=list |
| 0.162.0 | codex_cli_rs | 200 | 同样含 gpt-6.1-sol |

上游 `models-manager/models.json` 将 6.1 Sol 的 minimal_client_version 标为 0.153.0，但它不等于线上实际发现门槛。请求版本升至本次已验证的 0.162.0（上游已有 rust-v0.162.0-alpha.20；目录发送去预发布后缀的整版本）。不更改 originator，不将静态模型强行加入账号目录。

补充精确 `gpt-6.1-sol` 的 Lite 后备，目录存在时仍以 metadata 为准。新增精简上游 fixture，验证动态发现、六档 reasoning、默认 low / multi-agent xhigh、Fast 授权、metadata 优先及未知近似名称不误用 Lite。

当前 3080 GUI 的 hu profile 安装的是插件 0.11.1，请求版本 0.153.4。本轮只修改并构建仓库，未替换 profile 安装或重启当前会话；仓库修改不会自动改变正在运行的 GUI。

验证：`npm run build`、`npm test`（26 文件 / 469 项）、`npm run typecheck`、`git diff --check` 全部通过；生成产物一致性测试通过。使用新构建的 NativeCodexCatalog + NativeCodexAdapter 查询当前账号，已返回 `gpt-6.1-sol` 与 `gpt-6.1-sol-fast`，六档推理配置及默认 low 解析成功。本轮未执行模型推理，因此此结果验证发现与元数据，不代表线上推理端到端验收。

### 独立后续兼容性工作

- Retry-After：新上游从 response.failed.response.error.headers 读取等待提示，WebSocket 优先嵌套 headers，支持数字 JSON 值和 HTTP 日期；插件仍遗漏部分嵌套提示并将等待上限压到 120 秒。建议单独对齐共享解析及 deadline 传递，避免早于服务端建议重试。依据 `codex-api/src/sse/responses_error.rs`、`endpoint/responses_websocket.rs`、`http-client/src/retry_after.rs`。这不是 6.1 模型目录缺失原因。
- 数字自定义 reasoning effort、Standard instructions 移入 developer input、partial_answer phase 回放保真分别存在增量差异，应单独设计与验证。6.1 现有命名 effort 和 Lite 路径不依赖这些改动。


## 已实现：Sol 与错误协议增量适配（0.11.2）

参考上游 `c44deff7b1083e9660ac55d02122481f1cdf139b`，在既有 0.11.1 工作树上完成以下必要改动。此节取代下方历史审查中相应的“待适配”结论；不代表完整上游运行时对齐。

- 模型目录仍动态获取，查询 `client_version` 升至 `0.155.0`，满足上游 Sol 条目的最低版本。仅为缺失目录 metadata 的精确 `gpt-6-sol` 增加 Lite 路由后备；正常目录的 `use_responses_lite` 仍是依据，Fast 仍须目录授权，未知模型不按名称前缀猜测协议。
- HTTP 错误正文、SSE `response.failed` 与 WS `error` / `response.failed` 共用安全分类。`slow_down` 按限流处理并保留有界等待提示；新增三类 credit/organization/project 额度错误映射宿主 `QUOTA`；`invalid_prompt` 映射独立的 `INVALID_PROMPT`。这些失败不会在传输内重试、重连或回退 HTTP；原有 WS error 包装的限流代码 `RATE_LIMITED` 保持兼容。
- 图片生成/编辑 HTTP 失败及 JSON/UTF-8 解码失败，通过正式 LlmError failure 元数据保留状态码和校验后的 requestId。图片专用响应头优先；拒绝非法 ID 与 token/account 回显，不增加图片 POST 重试。
- 新增来自上游的精简 Sol fixture（含全部六档 reasoning effort），覆盖动态目录、最低版本过滤的模拟服务、metadata 优先、缺目录后备、Fast 权限；HTTP/SSE/WS 回归覆盖上述错误的终止行为和隐私边界。模拟版本过滤验证客户端请求条件，不证明真实账号一定获得 Sol。

验证：`pnpm build`、`pnpm test`（26 文件 / 467 项）、`pnpm typecheck`、`git diff --check` 全部通过；生成产物与新鲜编译一致。已更新相关 `lib/` 产物和 CHANGELOG，保留全部已有工作树改动。没有运行真实账号推理、查询线上目录或发布/替换常驻 GUI 插件；当前进程是否使用新构建未验证。Provider/cloud 原始跟踪提交仍分别保持 `ddf04ad` / `b348fc26`，为集合 0.3.7 准备插件版本 0.11.2；尚未发布。

## 上游增量审查：064e701b（插件 0.11.1 工作树）

本次 `../codex` 从 `b348fc26674189f758d5941cdab3f78f258b2aa7` fast-forward 到 `064e701b0fa4f5c0dcaf195a565d088f99bb6af8`，新增 596 个提交；更新后 HEAD 与本次 fetch 的 origin/main 一致，工作树干净。插件以当前已有未提交改动的 0.11.1 工作树为审查对象（Git HEAD 为 `188abd13430b3fff7782c1ee87e5809c4a2e8e96`），不是仅审查已提交版本。

结论：建议做针对性的兼容适配；目前证据不支持“必须整体重写”或“已完整对齐最新上游”。本次只更新上游并记录审查，没有修改插件运行时代码、跟踪常量或发布版本。

### 优先适配：失败响应分类

上游 `codex-rs/codex-api/src/sse/responses.rs` 的变化直接影响现有推理路径：

- `slow_down` 现在与 `rate_limit_exceeded` 一样表示限流，并解析服务端建议等待时间。插件 `src/responses.ts:333` 的 `responsesFailure` 仅对后者返回 `RATE_LIMIT`，前者落入 `SERVER`。
- `credit_balance_exhausted`、`organization_spend_limit_exceeded`、`project_spend_limit_exceeded` 现在明确归为额度耗尽。插件未按这些 code 分类；若 message 未命中宿主的额度文本识别，会落入 `SERVER`，影响不可重试额度错误的判断。
- 已用现有 `lib/responses.js` 直接调用复现：上述四个 code 搭配中性 message 均返回 `SERVER`，对照 `rate_limit_exceeded` 返回 `RATE_LIMIT`。这是本地确定性复现，不是线上故障记录。
- `bio_policy` 在上游已独立分类；插件仍返回不可重试的 `INVALID_REQUEST`。这是诊断粒度差异，优先级低于限流和额度分类。

建议首个适配单元覆盖错误分类、等待时间，以及 HTTP/SSE、WebSocket 两条传输中的终止/重试语义；仅修改版本号不能解决差异。

### 可按需要扩展的能力

- **WebSocket 握手稳定性**：本次上游将已有 HTTP 基础设施 cookie store 接入 WSS 握手，并从成功或拒绝的 upgrade 响应回收 Set-Cookie（`websocket-client/src/lib.rs:145`）。插件没有对应 cookie store。可作为下一优先级的稳定性适配，但未验证当前账号存在握手故障。HTTP cookie store 是上次基线已有能力，不能将整个缺口归为本次新增；实现时应遵循 host/TLS 和基础设施 cookie allowlist，不共享账号/会话 cookie。
- **WebSocket 空增量续传**：上游 `core/src/client.rs:1377` 放宽为允许与已完成上下文相等的 input；插件 `src/native-websocket-session.ts:83` 默认仍要求严格增长，仅预热例外。可减少无新增 input 时的全量重发，当前没有数据丢失证据。
- **目录 access programs**：新增可选 `available_access_programs`，插件未建模；需要对应模型访问计划选择时再接入，不能单凭字段新增判定目录解析失败。

- **工作区路由与 gateway OAuth**：上游增加账号工作区路由发现以及独立 gateway 登录。插件仍限制凭据端点为 chatgpt.com 或 loopback（`src/endpoint.ts`），没有对应发现流程。需要面向这类工作区或网关时再设计端点信任、账号绑定及切换后的缓存/连接隔离。上游 `login/src/auth/manager/workspace_routing.rs:63` 明确保留无 resolver 调用者的旧行为，不能据此认定普通 ChatGPT 登录已失效。
- **推理强度增量更新**：目录新增 `supports_reasoning_effort_updates`；上游以 `configuration_update` 历史项保留请求基线、减少切换 effort 的缓存损失。该路径受功能开关、provider 和模型能力共同控制（`core/src/client.rs:548`）。插件继续使用请求级参数；属于缓存与功能对齐项目，尚无证据表明普通请求因此不兼容。
- **图片文件引用**：`protocol/src/models.rs:897` 新增 `ImageReference::File { file_id }`，原有 `image_url` wire 形状仍保留。插件继续发送内联图片；搜索结果只提取 `image_url` 图片，不能将不认识的 file_id 视为已下载附件。可在明确上传、下载和账号作用域后单独接入。

### 深入评估：推理增量更新与 file_id

推理增量更新建议先做有开关的实验，暂不默认启用。插件当前 `responses.ts:245` 将 effort 放在请求属性中，`native-websocket-session.ts:57` 对请求属性做复用哈希，因此 effort 改变会使增量链不满足复用条件。保持请求基线并追加 configuration_update 有明确的客户端复用收益机制，但服务端缓存收益尚未实测。真正成本是持久化：现有 `replay.ts:7` 只记录 message/reasoning/function_call，不能直接表示宿主生成的配置更新及其历史位置。需先确认宿主能否提供稳定的轮次、分叉、压缩边界和持久化扩展点，再决定插件内扩展是否足够，不能只做进程内 sessionId→effort 缓存。验收应覆盖 medium→high→medium、断线/重启、分叉、失败重试、成功/失败压缩、模型切换以及能力缺失时保留请求级 effort。收益验证比较匹配历史的缓存输入量、请求字节数和首 token 延迟，不预设改善比例。

file_id 建议暂缓产品化，先验证后端契约。补充检查发现上游 `attachment-store/src/lib.rs:161` 提供的 InlineAttachmentStore 直接返回原字节；`core/src/thread_manager.rs:498` 默认图片存储仍使用它。`core/src/image_preparation.rs:363` 接受可注入存储返回 File，并在上传失败时回退内联。因而协议存在 file_id 不等于默认 Codex 已经提供现成可复制的图片上传闭环。`codex-api/src/files.rs` 的通用/连接器文件上传也不能未经验证就当成 Responses 图片上传。下一步应以一张合成小图验证上传→finalize→同账号 Responses 识图→引用失效/解析契约；若不能确认接受性与生命周期，继续内联。后续实现优先将远端 ID 作为插件内部、按账号与内容隔离的缓存，保留 DSH 本地附件作恢复依据；应对重新上传、账号切换、并发、取消、签名 URL 凭据隔离，并避免中途改变历史图片表示破坏 WS 前缀。现有 WS 增量已避免重复发送不变历史，因此收益主要在 HTTP、多次新连接或跨请求复用，不能直接宣称节省视觉 token。

本轮为源码评估，无线上请求和运行时代码修改；为读取上游接口追加了 `codex-rs/attachment-store` 稀疏检出目录。

### 当前无需随上游机械改动的接口

本次区间 `codex-api/src/search.rs`、`images.rs`、`endpoint/images.rs` 无变化；`endpoint/search.rs` 保留 `alpha/search`，主要是内部常量和测试类型调整。普通 Responses HTTP/WebSocket 仍使用 `/responses`，移除的是 Guardian 专用分支，不要求插件改路由。模型目录支持自定义 URL 和更多可选元数据，不等于默认目录的旧字段全部失效。

### 验证与边界

`pnpm test`：26 个文件、384 项测试全部通过；`pnpm typecheck` 通过；测试包括现有生成产物与新鲜 TypeScript 编译的一致性校验。未执行真实 OAuth、刷新或付费推理；现有回归通过不覆盖上游所有新增行为。原 Provider 基线 `ddf04ad` 与云能力基线 `b348fc26` 保持不变。下方历史章节中的旧缺口、旧测试数量和账号验证不能自动视为当前工作树结论。

## DSH 0.1.5-rc.1 版本适配

`0.10.1` 迁移 ToolCallId、精确 SDK 依赖和客户端服务提供包，隐藏策略在目录发布投影之前执行。`tests/target-directory.spec.ts` 执行官方 shell 的真实 store/Zustand/Immer 与目标目录/catalog 类，使用合成 Remote 响应和投影输入；这不是浏览器联合验收。`tests/target-services.spec.ts` 使用真实 Cordis/LlmRuntime/ToolRuntime、真实 loopback HTTP/SSE/WebSocket，验证工具 ID、工具执行、含加密 reasoning 的历史回放、永久错误和取消，并确认 WS 没有偷偷回退 HTTP。实际 socket 测试也修复了 ws 成功回调为 null 时的误判。

该版本不运行真实 OAuth、账号刷新或付费请求，不改写既有用户数据；旧版兼容性不在声明范围。下面的线上账号结果来自原 0.10.0 验证，不能视作本版本的新验证。升级/回滚建议见 README。

## 原 0.10.0 实现与验证边界

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
