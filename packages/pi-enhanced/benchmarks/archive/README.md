# 历史实验入口

这里保留早期实验的源码，供检查实现和复现历史方法。它们不再出现在日常 npm 脚本、普通 CI 或发布包中。

| 文件 | 原用途 |
|---|---|
| `p5-evaluation.ts` | 八个确定性本地夹具的工具回放 |
| `quality-evaluation.ts` | Memory/Context 手工小样本评测 |
| `release-benchmark.ts` | 检索和上下文延迟观测 |
| `task-manager-benchmark.ts` | 合成任务与恢复观测 |
| `memory-governance-benchmark.ts` | 记忆治理合成样例 |
| `run-ablation.ts`、`ablation-configs.json` | 旧模型消融矩阵 |

相对路径已适配新目录，保留原实验流程和输出行为，历史数据没有移动。部分入口仍向固定 `docs/` 文件写结果；如需复现，应在独立检出运行，避免覆盖既有报告。模型消融仍需另行授权，不是当前 SWE OFF/V1/V2 入口。

现有沙箱、网关、生命周期和 SWE 回归测试继续保留在 `tests/`。旧 Batch 名称仍是 CI 的测试身份，不能仅按名称归档或删除。
