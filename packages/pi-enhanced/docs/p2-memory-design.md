# P2 Memory 数据与隔离设计

本文是 P2-0 的设计结论，不代表业务代码已经实现。

## 1. 模块关系

```text
Memory Extension
  └─ MemoryService（校验、状态迁移、去重、作用域）
       ├─ CoreMemoryStore（受信任项目内 Markdown）
       ├─ LocalMemoryProvider（项目独立 SQLite）
       └─ SessionRecallAdapter（Pi Session 只读来源）
```

P2 只提供显式保存、修改、删除和检索。它不把结果自动注入模型上下文；自动注入属于 P3。任务是否完成也不由 P2 判断；自动保存“修复经验”在 P4 之前保持关闭。

## 2. 项目作用域

### 2.1 项目根和项目 ID

P2 将 `ctx.cwd` 视为 Pi 当前工作区根，不自行猜测 Git 根目录。创建 scope 时：

1. `resolve` 后取得绝对路径；
2. 对现有目录执行 `realpath`，消除符号链接；
3. Windows 下生成不区分大小写的 identity key，但保留原始规范路径用于显示；
4. 计算 `projectId = sha256("pi-enhanced-memory:v1\0" + identityKey)`。

两个同名目录只要绝对路径不同，就得到不同 projectId。项目重命名后不会自动继承旧数据，必须通过后续显式迁移命令更新路径映射，避免根据文件夹名或 Git remote 猜测归属。

### 2.2 物理隔离

每个项目使用独立目录：

```text
<agentDir>/pi-enhanced/memory/projects/<projectId>/
  project.json
  memory.sqlite3
  memory.sqlite3-wal
  memory.sqlite3-shm
```

`project.json` 只保存 schema 版本、projectId、规范路径和未来显式登记的旧路径。SQLite 表仍保留 `project_id` 并在所有查询中校验，形成物理目录和 SQL 条件两层隔离。

工具参数不接受任意 `projectId`。MemoryService 在 `session_start` 绑定当前 scope，模型不能通过参数切换到其他项目。

项目未受信任时，即使用户级配置打开 Memory，也不创建目录、不打开数据库、不读取 Core Memory 或 Session 索引，只显示 `blocked: project not trusted`。

## 3. Episodic Memory 数据结构

```ts
type MemoryKind = "fact" | "decision" | "experience";
type MemoryStatus = "candidate" | "verified" | "stale" | "rejected";
type MemorySourceType = "user" | "file" | "session" | "test" | "git";

interface MemorySource {
  type: MemorySourceType;
  ref: string;
  commit?: string;
}

interface MemoryVerification {
  type: "user_confirmed" | "test_passed" | "file_observed" | "git_observed";
  ref: string;
  verifiedAt: number;
}

interface MemoryRecord {
  id: string;
  projectId: string;
  kind: MemoryKind;
  content: string;
  status: MemoryStatus;
  source: MemorySource;
  verification?: MemoryVerification;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
}
```

规则：

- `source.ref` 必填，必须能定位到文件、Session entry、测试或 Git 证据。
- `session` 来源和模型总结默认只能创建 `candidate`。
- `verified` 必须有 verification；仅有“Agent 说过”不满足条件。
- 精确去重键为 `(projectId, kind, contentHash)`。hash 基于换行、空白和 Unicode 规范化后的内容。
- 语义近似或内容冲突不自动覆盖，返回给用户审阅。
- 删除是事务内真删除，FTS 索引同步清理；状态变化保留 `updatedAt`。

推荐状态迁移：

| 当前状态 | 允许进入 | 条件 |
|---|---|---|
| `candidate` | `verified/rejected` | verified 需要有效 verification |
| `verified` | `stale/rejected` | 显式操作并保留原因 |
| `stale` | `verified/rejected` | 重新验证后才能 verified |
| `rejected` | `candidate` | 显式恢复，不直接 verified |

## 4. Provider 与 MemoryService

Provider 只负责存储，不决定事实是否可信：

```ts
interface MemoryQuery {
  projectId: string;
  text: string;
  limit?: number;
  kinds?: MemoryKind[];
  statuses?: MemoryStatus[];
  sourceTypes?: MemorySourceType[];
}

interface MemoryProvider {
  search(query: MemoryQuery): Promise<MemoryRecord[]>;
  upsert(record: MemoryRecord): Promise<string>;
  get(id: string, projectId: string): Promise<MemoryRecord | null>;
  list(projectId: string): Promise<MemoryRecord[]>;
  delete(id: string, projectId: string): Promise<void>;
  close(): Promise<void>;
}
```

`LocalMemoryProvider` 首版使用同步 `DatabaseSync`，对外保留 Promise 接口，方便生命周期和未来 Provider 兼容。P2 不实现 Mem0 云端 Provider。

`MemoryService` 负责：

- 将每次操作绑定到当前 project scope；
- 长度、类型、秘密模式和来源校验；
- 计算规范化内容与 contentHash；
- 执行状态迁移和 verification 约束；
- 默认检索仅返回当前项目的 `verified`；
- 限制返回条数和单条内容长度；
- 把存储错误转换为 Memory 自身的受控降级，不影响 Pi 或 P1。

## 5. SQLite Schema 与全文检索

建议 schema：

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE memories (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  normalized_content TEXT NOT NULL,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  source_commit TEXT,
  verification_type TEXT,
  verification_ref TEXT,
  verified_at INTEGER,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, kind, content_hash)
);

CREATE INDEX memories_scope_status
  ON memories(project_id, status, kind, updated_at DESC);
```

FTS5 作为 `memories` 的 external-content 索引，通过触发器同步 insert/update/delete。所有写操作和 migration 使用显式事务；打开连接后设置：

- `PRAGMA foreign_keys=ON`；
- `PRAGMA journal_mode=WAL`；
- `PRAGMA synchronous=NORMAL`；
- `PRAGMA busy_timeout` 使用有限等待值。

搜索流程：

1. 先按 projectId、status、kind、source 形成候选边界；
2. ASCII 单词、函数名和路径使用转义后的 FTS5 查询；
3. 含中文查询同时执行有上限的字面量匹配，弥补默认 tokenizer 的子串不足；
4. 合并、去重并限制结果；
5. FTS5 不可用时报告 degraded，只保留受限字面量搜索。

不实现向量相似度、Embedding 或远程检索。

## 6. Core Memory

Core Memory 固定为受信任项目内的三个文件：

```text
<projectRoot>/.pi-enhanced/memory/
  project.md
  architecture.md
  decisions.md
```

```ts
type CoreMemoryName = "project" | "architecture" | "decisions";

interface CoreMemoryDocument {
  projectId: string;
  name: CoreMemoryName;
  relativePath: string;
  content: string;
  contentHash: string;
  modifiedAt: number;
}
```

Core 文件只在显式命令中读取或写入，不在启用模块时自动创建，不自动加入 Git，也不自动进入系统提示。路径由固定 name 映射，不接受任意用户路径。

安全检查：

- 项目必须受信任；
- 规范路径必须仍位于 project root；
- 拒绝 `.pi-enhanced` 或目标文件中的符号链接越界；
- 写入使用同目录临时文件和原子替换；
- 不修改、复制或生成 `AGENTS.md`；
- 若检测到疑似 Key、token 或私钥，默认拒绝保存并提示用户处理。

## 7. Session Recall

```ts
interface RecallRecord {
  projectId: string;
  sessionId: string;
  sessionFile?: string;
  entryId: string;
  branchLeafId: string | null;
  role: "user" | "assistant" | "toolResult" | "custom";
  content: string;
  contentHash: string;
  entryTimestamp: string;
  indexedAt: number;
}

interface RecallHit extends RecallRecord {
  score?: number;
  projection: "raw-active-branch" | "model-visible";
}
```

默认 Recall 范围是当前 Session 的当前活动分支：

- 每次查询读取 `getSessionId()`、`getLeafId()` 和 `getBranch()`；
- entry ID 与 Session ID 组成稳定来源引用；
- `getEntries()` 不用于默认搜索，避免混入已离开的分支；
- projection 只在用户明确查询“当前模型上下文”时使用；
- Recall 命中不能直接升级为 verified，只能作为 candidate 的来源。

跨会话 Recall 配置默认关闭。显式启用时，索引记录必须同时满足 projectId、规范 cwd 和受支持 session 路径约束。索引以 `(projectId, sessionId, entryId, contentHash)` 幂等；只有完整列举成功后才清理已删除 Session 的孤儿项。读取或解析失败时保留旧索引并报告，不误删数据。

跨会话索引不得调用可能迁移文件的 `SessionManager.open()`，不得写回 JSONL，也不得扫描 `SessionManager.list()` 未返回的任意目录。

## 8. 生命周期与禁用语义

```text
session_start
  ├─ disabled → 只保留状态，不访问任何 Memory 路径
  ├─ untrusted → blocked，不访问任何 Memory 路径
  └─ enabled + trusted → 创建 ProjectScope，再打开服务

session_tree
  └─ 清除当前分支 Recall 缓存（若实现缓存）

session_shutdown
  └─ 停止索引、关闭数据库、清空 runtime 引用
```

`session_compact` 和 `agent_settled` 在首版不触发自动写入。P2 不注册 `context` 或 `context_with_system` 处理器。

## 9. 安全和打包

- SQLite 与项目映射位于 agentDir，不在 npm Package 目录内。
- `.pi-enhanced/memory/` 是用户项目数据，Package 不收集、不复制。
- Memory 搜索结果标记为数据，不解释其中的命令。
- 状态和错误日志不输出完整记忆、Session 内容或凭据。
- `npm pack --dry-run` 必须确认不存在数据库、WAL、SHM、项目记忆或真实 Session。

