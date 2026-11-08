# 当前工作交接

## 当前任务与授权

- 项目：`F:\项目代码\pi-agent` 的 `packages/pi-enhanced`。当前聊天默认目录 `wzAgent` 不是本项目仓库。
- 用户已将任务从“只读提交审查”调整为“整理项目结构”，并明确选择：旧实验移出日常入口、归档仍需复现的代码、仅删除确认无引用的代码。
- 不使用 subagent；不提交、不推送、不运行付费模型。真实实验数据、已消费授权和原有 42 项文档删除必须保留。
- 当前 HEAD：`106d6e190bd516e1fb6b718b979040db7f5c6d43`。旧 Commit 的绿色 CI 不代表当前工作树。

## 从哪里读代码

- [Package README](packages/pi-enhanced/README.md)：五个扩展、配置与目录导航。
- [评测调用关系](packages/pi-enhanced/benchmarks/real-agent/README.md)：批次 → 单组 → 准备/执行/结果 → 官方判分。
- [归档实验](packages/pi-enhanced/benchmarks/archive/README.md)：独立 P5、消融和合成基准。
- [完整历史交接](packages/pi-enhanced/docs/history/HANDOFF-before-structure-cleanup.md)：本轮开始前的 HANDOFF 原始字节副本。旧阶段要求和授权只作历史证据，不自动成为新任务。

## 本轮整理

- 归档 6 个独立实验脚本和 1 个消融配置；移除对应日常 npm 命令、普通 CI 中的 P5/质量实验，发布包排除归档与历史交接。
- 普通 CI 改用已有 `--preflight`，不再通过默认 Runner 入口重写 P5 历史报告。
- 测试身份清单脚本迁到 `scripts/ci/test-manifest.ts`，要求显式输入基线和输出路径，不再默认使用已删除的 Batch D 报告。
- `swe-profile.ts` 独立声明 SWE 配置；`evaluation-identity.ts` 保存既有散列规则；`swe-results.ts` 收集 SWE 结果。Runner 的预算、授权、工具限制和结果格式不变。
- 未按旧 Batch 名称删除测试。仍在被 CI 和安全回归使用的历史协议代码继续保留。
- 整理前文件备份与源码散列位于 `.artifacts/structure-cleanup/before/` 和 `before.json`，不是新实验批次。

## 最终验收现状

- 三份状态分开看：HEAD 旧 CI；整理前 26 项 SWE 修复（`.artifacts/swe-continuation/candidates.json` 与 `.artifacts/structure-cleanup/before/`）；当前结构整理后源码。不能把 HEAD 到当前的差异都算成结构整理。
- Linux 中已复现暂停进程收不到 `SIGTERM` 的超时问题；`runner-execution.ts` 仅在 Linux 超时分支先发 `SIGCONT`，再发原有终止信号。实际 Linux Pi Runner 加 Docker 链路尚未实测。
- 当前 Windows 完整离线 TypeScript 为 288 通过、0 失败、3 跳过。Batch J 夹具改为先注册消息监听、再发送就绪通知；对应文件专项 13 通过、1 跳过，随后整轮也通过。旧失败日志保留在 `.artifacts/structure-cleanup/final/`，本轮测试工具结果为其中的 `current-vitest.json`。
- Python 15/15（本轮仅改 TypeScript 测试夹具，未重复运行）；预检、291 项测试身份清单和包内 TypeScript 类型检查通过。此前 9 项工程/类型/打包检查、28 文件 Biome、归档脚本路径检查通过。根 `npm run check` 含全仓 `--write`；本轮只读根 Biome 扫描遇到 `.artifacts` 内历史仓库的嵌套配置，夹具路径本身不在根 Biome 配置的检查范围。
- Linux Node 能加载当前 Runner 模块；只读源码的 unit/integration 为 213 通过、6 项子进程 10 秒超时失败、1 跳过。相同挂载环境中，无执行参数的 Runner 正常退出耗时约 10.9 秒，另一拒绝执行入口耗时约 18.3 秒；先归为该挂载环境的启动耗时限制，不改超时阈值。自动权限审查拒绝把宿主 Docker socket 和可写仓库同时交给容器，因此 Linux Docker 强制用例及证据门槛未完成；Windows 宿主调用 Docker 不能代替它。
- 124 个历史保护文件、42 项原有删除和 78 个运行时源码/扩展/Python 文件仍保持不变。当前候选清单位于 `.artifacts/structure-cleanup/candidates.json`，原有历史报告与已消费授权不进入候选范围。未暂存、未提交、未调用付费模型。
- 结构说明与剩余耦合见 `packages/pi-enhanced/benchmarks/real-agent/README.md`。目前不具备提交条件，主要阻断是 Linux Docker 强制用例及证据门槛未完成；保留当前未提交工作树。

## 真实实验条件

先审查新的精确提交范围并取得提交/推送批准，再通过新 Commit 的 Windows/Linux/Docker CI。在干净检出和真实宿主校准 OFF/V1/V2 输入，检查 Linux 官方评测环境后，单独批准总额 USD 0.24，创建绑定新 Commit、CI、配置、逐模式指纹、唯一输出和有效期的一次性 grant。

旧 USD 0.09 授权已消费，不复用旧 grant、旧输出目录或历史 host-pilot 脚本。三组仍采用受限源码协议；当前没有新的官方 resolved 或 Task 收益结论。
