# P1 测试报告

测试日期：2026-10-29。基线 Commit：`842c73170a3658d4e3b39fcc84690211ed503e09`。

## 持久化测试

运行：

```powershell
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run tests/unit tests/integration
```

首次 P1 验证结果为 5 个测试文件、21 项测试，全部通过。2026-10-30 收尾新增“异常中止后缺失 `tool_result`”审计容量测试后，共 22 项；最终结果见下方收尾记录。

覆盖内容：

- P0 四入口独立加载、默认关闭和 reload 回归；
- deny 优先级、工具级/Server 级/默认策略、固定优先级；
- 未知工具、虚假只读 annotation、非法工具名、参数不修改；
- 用户级 deny 不被项目 allow 覆盖，未信任项目配置不加载；
- 审计容量、脱敏、父调用 ID、无 `tool_result` 的拒绝记录；
- 真实 stdio fixture 的 `direct`、`deferred`、`codemode`；
- codemode 嵌套写入阻断、动态工具列表更新后未知工具阻断；
- 无 UI 拒绝、用户拒绝、错误配置关闭执行；
- reload 清空审计、重复 shutdown 不报错。
- `tool_result` 缺失时待处理审计保持定长，最早记录以 `unknown` 收束，shutdown 后清空。

## 外部组件测试

运行：

```powershell
$env:PI_ENHANCED_RUN_EXTERNAL_MCP='1'
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run tests/e2e/mcp-components.test.ts
```

初次结果：1 个测试文件、1 项测试通过。无 Key 分支完成真实握手、工具发现和查询端点调用，并识别匿名额度错误。2026-10-31 使用免费 Key 复跑同一测试，`resolve-library-id` 与 `query-docs` 均返回非错误且非空内容，Context7 成功检索状态改为 `passed`。

2026-10-31 使用官方 Serena `2.1.0` 镜像补充 Docker E2E。测试锁定镜像摘要，以只读 fixture 和 tmpfs 缓存完成 `find_symbol` 与 `find_referencing_symbols`，1 项通过；Windows 直接安装限制不再阻塞该项。

## 仓库检查

最终运行：

```powershell
npm run check
```

结果：通过。检查包含 Biome、固定依赖、运行时依赖、TypeScript 导入、入口依赖图、Coding Agent 安装锁、全仓 TypeScript 和浏览器 smoke。

`npm pack --dry-run --workspace=@wz-agent/pi-enhanced` 通过；加入 P1 收尾报告后，Package 预览包含 26 个发布文件，没有把 tests、fixture 或本地临时目录打进 tarball。`npm ls --all` 退出码为 0，没有无效或缺失的必需依赖；输出中的 `UNMET OPTIONAL DEPENDENCY` 均为非当前平台或可选集成。

## 依赖审计

`npm install --package-lock-only --ignore-scripts` 成功。`npm audit --omit=dev` 仍报告 2 个 high，来自现有链路 `@anthropic-ai/sandbox-runtime@0.0.26 -> zod@3.25.76`，npm 标记 `No fix available`。这不是 P1 新增的运行时依赖；`pi-enhanced` 新增的测试依赖固定为 Pi `1.4.0` 系列。

2026-10-30 重新查询结果不变。源码触达检查确认 `pi-enhanced` 不导入 sandbox runtime；Zod 仍由 Pi 模型 SDK 共享，不能把宿主风险记为完全不可达。具体缓解和边界见 `p1-known-limitations.md`。

## 2026-10-30 收尾验证

- 第一次复跑时临时目录路径被重复拼接，Vitest 在导入测试前因 `EPERM` 退出，没有执行用例；改用 Package 当前目录下的 `.closure-test-tmp` 后正常运行，临时目录已删除。该项是测试命令设置错误，不是代码测试失败。
- `py -0p`：只有 Python 3.14，Serena 状态为 `blocked_by_environment`。
- `CONTEXT7_API_KEY`：未提供，Context7 成功取文档状态为 `blocked_by_quota`。
- 凭据模式扫描：`packages/pi-enhanced` 与本轮改动中未发现 API Key、私钥或明文凭据。
- 产物扫描：未发现外部 MCP 日志、真实会话记录或本地记忆数据；测试 fixture 只记录临时目录中的工具名，并在测试结束后删除。
- 宽泛 allow 检查：仓库没有写入真实策略配置；README 示例改用两个 Serena 精确工具名，Context7 只允许精确的 `query-docs`。
- 持久化测试：5 个文件、22 项全部通过。
- Context7 外部测试：1 个文件、1 项通过；无 Key 分支确认 `blocked_by_quota`。
- `npm run check`：通过，Biome 无修正项，固定依赖、运行时依赖、导入、入口图、安装锁、TypeScript 和浏览器 smoke 全部通过。

## 2026-10-31 Docker 补验

- 官方 Serena 镜像 label：版本 `2.1.0`，revision `5e4f5cd173c7ff3eed37ee3f1de6c266b937c5dc`。
- 官方镜像摘要：`sha256:eb52535ff1c292add25c2b2d37b2db4e2e20c60cda7d8e25f9d11490ce0e1bdf`。
- Serena E2E：1 项通过，完成真实符号与引用查询；Context7 分支跳过。
- 受控项目源码只读挂载，语言服务器缓存置于 tmpfs；没有修改 Pi 源码或真实用户配置。
- P1 既有 unit/integration 测试和 MCP Policy 实现未因本次外部验证而调整。
- 固化文件：`p1-security-baseline.md`，明确后续不得顺带修改现有 MCP Policy；路径级权限、完整审计和非 MCP 工具保护另立增强任务。
- Context7 E2E：1 项通过，固定 `@upstash/context7-mcp@4.4.4` 成功解析文档库并返回文档内容；Serena 分支跳过。
- Context7 Key 只从 Windows 用户级环境读入测试进程，没有打印或写入仓库。

