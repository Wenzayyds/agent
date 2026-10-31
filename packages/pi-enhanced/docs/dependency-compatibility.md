# 依赖升级兼容性记录

核对日期：2026-10-29。

## 本次变更

- 全局 npm 从 `11.9.0` 升级到 `11.21.1`。
- 执行 `npm audit fix` 后，`packages/durable` 的 `@cloudflare/vitest-plugin` 从 `1.4.4` 升级到 `1.4.10`，lockfile 中 Wrangler、Miniflare 等间接依赖随之更新。
- `npm ls --all` 通过，没有缺失、无效或重复解析错误。
- 根目录 `npm run check` 在依赖升级后通过。

## 尚存的审计项

`npm audit` 仍报告 2 个 high，来源链路包含 `@anthropic-ai/sandbox-runtime@0.0.26 -> zod@3.25.76`。当前 `sandbox-runtime` 的可用版本仍使用 Zod 3，`npm audit fix` 没有可自动应用的修复版本。强行用 override 把 Zod 3 替换成 Zod 4 可能破坏运行时兼容性，因此本次不做这种替换。

处理方式：

1. 保持 `@anthropic-ai/sandbox-runtime` 精确版本。
2. 定期检查其后续版本是否升级 Zod 或明确修复对应审计项。
3. 有新版本时先在 sandbox extension 和根目录检查中验证，再更新固定版本。

## Cloudflare Worker 测试限制

普通 durable 测试和类型检查不受影响。Worker 测试在 Windows 下使用包含中文字符的仓库路径时会失败，错误来自 Cloudflare 测试运行时对内部模块路径 `cloudflare:test-internal` 的解析。这是运行环境限制，不是本次依赖升级造成的 TypeScript 或业务代码错误。

复查 Worker 测试时，应把仓库复制或检出到只含 ASCII 字符的临时路径后执行：

```powershell
npm run test:workers --workspace=@earendil-works/pi-durable
```

## `min-release-age` 的作用和后续处理

根目录 `.npmrc` 当前设置：

```ini
save-exact=true
min-release-age=2
```

`min-release-age=2` 表示 npm 在构建依赖树时，只选择发布至少 2 天的版本。它只影响版本选择，不会自动改写现有精确版本，也不会让 lockfile 中已经锁定的版本在两天后自行变化。

后续可能看到的现象：刚发布的版本暂时不可选；等待发布时间超过 2 天后，再次执行安装或更新时才可能进入候选范围。如果没有满足当前依赖约束且达到发布时间要求的版本，安装会报错。当安全修复版本因为发布时间窗口被拦住时，`npm audit fix` 会保留旧版本、给出提示并以非零状态退出。此时可以等待窗口结束；若修复紧急，也可以把指定包加入 `min-release-age-exclude`，或临时放宽该值，再完成完整验证。无需删除 lockfile。

由于仓库同时启用了 `save-exact=true` 并固定工作区依赖，日常安装应保留 `package-lock.json`，避免无意中重新解析整棵依赖树。
