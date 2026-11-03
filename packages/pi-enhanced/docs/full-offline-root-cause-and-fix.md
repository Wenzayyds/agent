# full 试验离线排查与修复

日期：2026-11-03。基于 36bf6e364 后的本地源码；本轮没有付费调用，没有重跑历史真实任务，没有改写历史产物。

## 1. 网关失败关闭

历史 memory-guided/full 总运行时间 19,882.785 ms，long-output/full 为 17,304.141 ms。两者 timedOut=false，网关请求超时配置为 120,000 ms，因此旧错误码 GATEWAY_UPSTREAM_TIMEOUT_OR_ABORT 不能解释成上游请求超时。

旧源码只有定时器和 downstream response.close 两处会触发 AbortController。排除定时器后，直接原因是 Pi 侧关闭响应触发了客户端断开处理。两份历史结果同时包含助手 usage 和成功的工具执行，证明响应已被 Pi 消费。

Pi 的 OpenAI Completions Adapter 使用 OpenAI SDK。当前 SDK 的 Stream.fromSSEResponse 在遇到 [DONE] 后 break，不等待 HTTP EOF。旧网关却在上游 for-await 完全结束后才记账。因此客户端正常读完 [DONE]，但上游 HTTP body 尚未 EOF 时，会触发 abort、丢掉已经收到的 usage，并把完整预留转为未知用量。

离线复现：模拟 Provider 写入 usage 与 [DONE]，延后 200 ms 结束 HTTP body；客户端收到 [DONE] 即取消读取。修复前稳定得到 failed_closed、requestsCompleted=0、actualTotalTokens=0；预期应该完成 120 Token。回归测试已保留。

修复：先解析 SSE，再转发；收到 [DONE] 时先结算一次，再发给客户端并结束网关响应，不再等待上游 EOF。增加 requestOutcomes，记录请求序号、完成/失败原因、收到字节数、usageSeen、doneSeen 和耗时。真正超时与客户端提前断开分别记录 GATEWAY_UPSTREAM_TIMEOUT / GATEWAY_CLIENT_DISCONNECTED。usage 缺失、格式无效、提前断开仍失败关闭，并保留完整预留。

历史限制：没有保留逐帧 SSE 和明确的断开原因，无法还原两次历史请求的每一个网络分包；不以离线复现覆盖历史账目，也不把 stdout usage 当成账单补记。

## 2. Memory 未命中

历史报告只记录 tool_execution_end 的 count=0，没有保存 enhanced_memory_search 的 query，原临时数据库已随运行清理。因此不能断言历史模型到底用了哪个查询，也不能把零命中归因于权限失效或数据丢失。

已复现的查询缺口：Provider FTS 将按空格分割的查询拼为 AND，literal 降级则匹配完整子串。种子只有 normalizeKey 的约定时，查询“修复 normalizeKey 保留 API”会零命中；查询 normalizeKey 本身能命中。Context 原先拿整个用户提示查询，且提示含额外任务 ID，更容易遇到同样问题。

修复不改 SQLite Schema 或 MemoryService：在模型只读搜索及 Context 参考检索前增加共用查询策略。完整查询先查；只有零命中时，最多尝试三个 camelCase/snake_case 标识符。每次仍使用原服务/ScopedMemoryReader 的项目、verified、生命周期和 kind 过滤。用户命令的 literal 搜索语义保持原样。不使用无条件 OR 或放开状态过滤。

模型工具 details 记录脱敏后的实际查询、降级策略和数量；Runner 保存工具调用入参及结果。实验种子创建后必须通过 verified 搜索预检，否则在启动模型网关前失败。

离线真实 SQLite 测试证明：候选隐藏；长查询原始结果为零；标识符降级命中 verified；归档后再次隐藏。生产 Runner Stub E2E 明确断言 count=1，避免只凭工具正文包含函数名就认定检索成功。

## 3. Context 缺少效果记录

原 Runtime 已有诊断，但只通过 enhanced-context-status/inspect 用户命令显示；评测 Runner 只保存 contextEnabled，没有接入诊断。因此开启开关不能证明发生选择、注入或截断。

新增可选诊断回调；普通 Extension 无回调时行为不变。评测专用 context-probe 复用原 Extension，将实际配置与每轮 ContextDiagnostics 写入受控运行根；只保存状态、ID、估算 Token 和计数，不保存消息正文。Runner 把它存为 context-audit.json 并关联到 result.json。回调故障不改变 Context 返回消息。

离线生产链路已证明：模拟 Provider 的真实请求中包含低信任记忆块，context-audit 存在 injectedMemoryIds；工具调用与结果保持关联。

Task 摘要跳过是有效性过滤：原实验创建的是 draft，绑定 controlled-pilot-setup，而非 Pi 活动会话。Context 只注入当前 session/branch 下的显式活动任务，不能为了实验而放开这些条件。诊断如实记录 skipped。

原配置 toolOutput 默认关闭，且两个小型任务的历史远低于默认 Context 预算；它们无法证明长输出截断或历史压缩有收益。现在记录实际配置、removedMessages、truncatedToolResults 和前后估算 Token，以区分“未触发”和“缺少记录”。记录转换不等于证明模型效果提升。

## 验证与边界

- 修复前的 SSE 竞态失败已离线复现；修复后对应回归通过。
- 本地 Pi Enhanced 回归 173 身份：171 passed、0 failed、2 外部 MCP 条件跳过；原 Batch I 166 身份缺失 0。
- Python 15/15；全仓 npm run check 通过。
- 模拟 Provider → 本地预算网关 → 真实 Pi CLI → Docker → Memory/Task 只读工具 → Context 诊断 → Patch → 独立验证器通过。
- 类型检查、打包安装 E2E 与包泄漏扫描通过；没有自动下载模型，没有访问付费 API。
- 清单：full-offline-fix-test-manifest.json；持久化模拟链路证据：full-offline-module-evidence.json；本地原始 Stub 报告：../.artifacts/offline-module-result.json。
- 本轮没有提交或推送。远端 CI 的旧通过结果仅覆盖此前源码，不冒充当前修改已被远端验证。

本轮不重新规划或执行真实对比。下一次规划应以已保存的查询、种子预检、Context 转换记录和网关逐请求结果为依据；历史四次试验仍保持结论不足。

## 提交前复审补充

随后用户授权审查、提交、推送并核对三类远端 CI。复审发现“有效 usage 后又收到无效最终 usage”可能被旧值覆盖，现改为失败关闭；显式负数/不一致 total_tokens 同样拒绝。requestOutcomes 优先记录实际预算校验错误。新增回归后，本地为 174 身份：172 passed、0 failed、2 条件跳过；原基线缺失 0，全仓 check 通过。旧四次真实试验仍未重跑。
