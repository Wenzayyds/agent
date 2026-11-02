# Batch D 基线与测试身份核对

日期：2026-11-02

## 代码与环境

- 当前仓库 HEAD：`8b575946297edf50175e1b0b62750e6729d52f80`。
- 固定 Pi Commit `842c73170a3658d4e3b39fcc84690211ed503e09` 仍是当前 HEAD 的祖先。
- Node.js `v24.14.0`，npm `11.21.1`，Python `3.14.2`，Windows x64。
- Batch D 开始时工作树已有 P0～P4 的未提交改动。本批没有 reset、clean、切换分支或覆盖这些改动。

## 109 与 108 的差异

上一轮“109 项”由两部分组成：unit/integration 108 项，加上 `tests/e2e/package-worker.test.ts` 1 项。Batch C 起始命令只收集 unit/integration，因此显示 108；把安装包 E2E 纳入同一口径就是 109。差异来自收集范围，不是测试文件或测试用例遗失。

Batch D 开始前按统一范围收集为 120 项：上述 109 项，加上 Batch C 新增的 11 项。起始身份清单位于 `batch-d-test-manifest.json`，共 120 项，SHA-256 为 `71384c51a4db7faa0e969d54802e1ef3f78bd0b4f80f27cf7e6700519f043798`。

## Batch D 最终身份核对

最终清单位于 `batch-d-test-manifest-final.json`。最终全量为 127 项；起始 120 个身份全部存在，`missingBaselineIdentities` 为空。最终清单采用排序后的“测试文件路径 + 完整测试名”作为稳定身份，而不是依赖易变化的收集顺序。

本批没有删除测试。新增覆盖真实子进程中断、P3 Task 注入、Task→Memory candidate 桥、Task schema v1→v2、忙锁和损坏库等路径。

## 检查边界

包级 TypeScript 检查和 `packages/pi-enhanced` 的 Biome 只读检查均通过。根目录的 pinned dependencies、runtime dependencies、TS import、entry graph、coding-agent install lock 和 browser smoke 六项只读检查也分别通过。根目录 `npm run check` 内含 `biome-check --write`，会改写整个脏工作树；为避免无关改动，本批没有运行这个带写入行为的总命令。这个选择是工作树保护措施，不记作“完整根 check 通过”。
