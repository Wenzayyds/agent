# P2-0 Memory 接口核对报告

核对日期：2026-10-31。固定 Pi Commit：`842c73170a3658d4e3b39fcc84690211ed503e09`。

本阶段只核对接口和设计，不实现 Memory 业务逻辑，不修改 Pi Core，也不进入 P3 Context 或 P4 Task Manager。

## 1. 基线和现状

| 项目 | 结果 |
|---|---|
| 当前 Git Commit | 与固定 Commit 完全一致 |
| `@earendil-works/pi-coding-agent` | `1.4.0` |
| `@earendil-works/pi-mcp` | `1.4.0` |
| Memory 入口 | `extensions/memory.ts` 仅转发到 `src/memory/extension.ts` |
| Memory 实现 | 仍是 P0 骨架，只注册 `/enhanced-memory-status` |
| 默认状态 | `enabled=false` |
| P1 影响 | 本阶段未修改 `src/mcp-policy/` |

现有 Memory 骨架通过 `registerModuleExtension(pi, "memory")` 复用模块开关和生命周期。`session_start` 读取配置，`session_shutdown` 清空内存状态，见 `src/shared/module-extension.ts:33-42`。当前没有注册工具，没有打开数据库，也没有读取项目记忆。

## 2. SessionManager 公开接口

`ExtensionContext.sessionManager` 的类型是 `ReadonlySessionManager`，见 `packages/coding-agent/src/core/extensions/types.ts:331-341`。它是 `SessionManager` 的只读方法子集，定义见 `packages/coding-agent/src/core/session-manager.ts:245`。

P2 可以直接使用的方法包括：

```ts
getCwd(): string;
getSessionDir(): string;
getSessionId(): string;
getSessionFile(): string | undefined;
getLeafId(): string | null;
getLeafEntry(): SessionEntry | undefined;
getEntry(id: string): SessionEntry | undefined;
getBranch(fromId?: string): SessionEntry[];
buildContextEntries(): SessionEntry[];
buildSessionProjection(): SessionProjection;
getHeader(): SessionHeader | null;
getEntries(): SessionEntry[];
getTree(): SessionTreeNode[];
```

### 2.1 `getEntries()`

实现位于 `session-manager.ts:1520`：返回 JSONL 中除 header 外的全部条目浅拷贝，包含所有分支和所有 entry 类型。

结论：

- 它适合建立整棵树、检查 entry 是否存在或做显式的全树分析。
- 它不代表当前活动分支。
- 返回值虽是新数组，但其中的 entry 和嵌套 message 不是深拷贝；P2 必须只读，不能修改对象内容。

### 2.2 `getBranch(fromId?)`

实现位于 `session-manager.ts:1469`：从指定 entry 或当前 leaf 沿 `parentId` 回溯到根，再反转为根到 leaf 的顺序。

结论：

- 不传参数时，它准确表示当前活动分支的原始条目。
- 它包含 message、compaction、branch summary、label、custom 等所有 entry 类型。
- 指定不存在的 `fromId` 时返回空数组，不抛错。
- `/tree` 改变 leaf 后，应在每次 Recall 查询时重新调用，不能长期缓存旧分支。

### 2.3 `buildContextEntries()` 与 `buildSessionProjection()`

`buildContextEntries()` 位于 `session-manager.ts:476`，只保留当前分支中压缩后继续参与上下文的条目。`buildSessionProjection()` 位于 `session-manager.ts:543`，进一步应用 `context_edit`，返回带来源 entry 的投影和模型消息。

三类数据不能混用：

| 接口 | 表示什么 | P2 用途 |
|---|---|---|
| `getEntries()` | 会话文件中的完整树 | 全树诊断或显式索引维护 |
| `getBranch()` | 当前 leaf 的完整原始路径 | Recall 的默认证据来源 |
| `buildSessionProjection()` | 当前模型实际可见的压缩、编辑后消息 | 解释“模型当前看到什么”，不替代原始证据 |

压缩不会删除原始条目。因此 Session Recall 若要提供完整历史，应从 `getBranch()` 取证；若要复现当前模型上下文，应使用 projection，并明确标记为投影结果。

### 2.4 分支、fork 和会话替换

同一 JSONL 内的 `/tree` 只移动 leaf，旧分支仍保留。`session_tree` 事件提供 `newLeafId`、`oldLeafId` 和可选 branch summary，见 `extensions/types.ts:860`。

`/new`、`/resume`、`/fork` 会替换整个 AgentSession runtime。`AgentSessionRuntime` 先发送旧 runtime 的 `session_shutdown`，再创建新 runtime 并发送对应原因的 `session_start`，见 `agent-session-runtime.ts:167-345`。旧 `pi` 和旧 context 随后失效。

P2 生命周期要求：

- `session_shutdown` 关闭数据库连接、取消索引任务并丢弃旧 scope；清理必须可重复。
- 新 runtime 只使用新的 `ctx.cwd`、信任状态和 `sessionManager`。
- `/reload` 同样销毁旧 runtime，不能复用旧服务实例。
- 当前分支 Recall 在查询时读取新 `getLeafId()` 和 `getBranch()`，避免 `/tree` 后返回旧分支内容。

## 3. 会话持久化接口

`SessionManager.appendCustomEntry()` 是可写方法，但不在 `ReadonlySessionManager` 中。Extension 的公开写入口是 `pi.appendEntry(customType, data)`，见 `extensions/types.ts:1757`；它会向当前 Session 追加不进入模型上下文的 custom entry。

P2 首版不需要使用它：Memory 的事实、状态和索引应保存在自己的数据库，不能把数据库状态复制进 Pi Session。这样可以保证：

- 不改写或膨胀原始 JSONL；
- Memory 关闭时不影响 Session；
- Session 仍是对话历史的唯一所有者。

跨会话方面，`SessionManager.list()` 是公开静态方法，能返回 session path、ID 和拼接后的 user/assistant 文本；但它不保留 entry ID，也不区分分支。`SessionManager.open()` 不是纯只读读取器：打开旧版本 Session 时可能迁移并重写文件。因此 P2 的只读索引器不得调用 `open()`。

如后续启用跨会话 Recall，只允许：

1. 用户显式启用项目级跨会话索引；
2. 用 `SessionManager.list()` 获取当前项目候选路径；
3. 校验 Session header 的规范化 `cwd` 与当前项目一致；
4. 只读文件，再用公开的 `parseSessionEntries()`、`migrateSessionEntries()` 和 `buildSessionProjection()` 在内存中处理；
5. 索引前后校验 JSONL 文件内容和时间戳未被修改。

首版默认只支持当前会话活动分支，跨会话索引默认关闭。

## 4. Extension 事件与注册接口

P2 需要的公开事件均存在：

| 事件 | 精确语义 | P2 决定 |
|---|---|---|
| `session_start` | `startup/reload/new/resume/fork` | 配置启用且项目受信任后创建 scope 和服务 |
| `session_shutdown` | `quit/reload/new/resume/fork` | 关闭连接和后台任务 |
| `session_tree` | 当前 Session 内 leaf 改变 | 使 Recall 分支缓存失效；也可直接取消缓存 |
| `session_compact` | 压缩成功 | 不自动写 verified；首版不自动提炼记忆 |
| `agent_settled` | 本轮执行完全停止 | 不是“修复已验证”证据，首版不自动写入 |

`registerTool()`、`registerCommand()` 均为公开 API。新增名称固定使用：

- 工具：`enhanced_memory_search`，后续写工具也必须使用 `enhanced_memory_` 前缀；
- 命令：`/enhanced-memory-*`。

Extension 内同名注册会覆盖该 Extension 自己 Map 中的旧定义；多个 Extension 的同名命令会被解析为带序号的 invocation name。P2 仍应在加载测试中主动检查名称，不能依赖自动改名。

## 5. AGENTS.md 与项目记忆的边界

Pi 的 AGENTS/CLAUDE 文件由 `loadProjectContextFiles()` 从 agent 目录、cwd 和祖先目录发现，见 `resource-loader.ts:211-300`。它们会进入系统提示，且不受项目 trust 控制；`--no-context-files` 才会关闭加载。

P2 必须保持以下边界：

| AGENTS.md | Core / Episodic / Recall |
|---|---|
| 行为指令和项目约束 | 可检索的事实、决策、经验和历史证据 |
| Pi 自动放入系统提示 | P2 只在显式命令或工具调用时返回 |
| 不要求项目 trust | Memory 必须要求 `ctx.isProjectTrusted()` |
| 由用户维护 | P2 不自动复制、改写或生成同义副本 |

Memory 命中的文本始终是不可信数据，即使内容像命令，也不能提升为系统指令。Core Memory 与 AGENTS 冲突时，AGENTS 仍是行为约束；Memory 只作为待核对事实返回。

`.pi-enhanced/memory/` 不属于 Pi 自动加载的 context 文件目录。P2 不修改既有 `AGENTS.md`，也不把它自动导入数据库。

## 6. SQLite FTS5 技术核对

仓库最低 Node 版本是 `>=22.19.0`。`node:sqlite` 从 Node 22.5.0 提供，当前 `@types/node@22.19.19` 已包含 `DatabaseSync`、prepared statement、事务所需接口和只读打开选项。仓库已有其他 Package 使用 `node:sqlite`，无需增加第三方运行时依赖。

实测结果：

| 环境 | SQLite | FTS5 | 结果 |
|---|---|---|---|
| 本机 Node 24.14.0 | 内置版本 | `ENABLE_FTS5` | 可创建 FTS5 表 |
| 官方 `node:22.19.0-bookworm-slim` | `3.50.4` | `ENABLE_FTS5` | 可创建 FTS5 表 |

Node 22.19.0 测试中，英文 `SessionManager`、中文完整词 `会话` 和路径词 `extension` 均命中；中文单字子串 `记` 不命中。结论：

- 首选 `node:sqlite`，不增加 `better-sqlite3` 或 `sqlite3`，避免 native addon、安装脚本和 lockfile 变化。
- Node 22 类型仍标记 SQLite 为 experimental，需要在已知限制中保留该事实。
- FTS5 默认 tokenizer 可用于英文、标识符和完整中文片段，但不能承担中文分词或任意子串检索。
- 中文查询采用“FTS5 + 当前项目内受限的字面量回退”，不能宣传为语义检索。
- 初始化必须探测 FTS5；不可用时 CRUD 仍可运行，搜索降级为有上限的字面量扫描，并在状态命令中报告。

数据库建议使用 WAL、foreign keys、busy timeout、prepared statement 和显式事务。用户输入不能直接作为 FTS 查询语法拼接，需先转义为字面 token，再通过参数绑定执行。

## 7. P2-0 结论

- 固定 Commit 的公开 Extension API 足以实现 P2，不需要修改 Pi Core。
- 当前会话 Recall 可以完全使用 `ReadonlySessionManager`。
- 跨会话存在公开的列举和解析基础，但没有单一步骤的纯只读 entry-level reader；默认关闭，后续只能通过受限只读索引器实现。
- `node:sqlite` 和 FTS5 在最低目标版本实测可用，可避免新增第三方依赖。
- AGENTS 是指令来源，Memory 是显式检索的数据来源，两者不能复制或互相替代。

