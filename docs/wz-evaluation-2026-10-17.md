# 完整版 SWE-agent 扩展：真实模型测评（2026-10-17）

## 结论

使用本机 `.env` 中的 DeepSeek 接口，对两个公开 GitHub Issue 各运行一次。扩展版均交付了**仅修改源代码、通过指定测试和额外独立检查**的补丁，可交付率为 **2/2**。同条件下，完整版 SWE-agent 原版两题的功能检查也都通过，但其中一题同时修改了已有测试文件；按本项目的交付规则，原版可交付率为 **1/2**。

这只是两道小型 Python 题、每组各一次运行，不能称作 SWE-bench 成绩，也不能据此推断总体成功率。扩展版总模型调用次数更少，但按统一峰时单价估算的费用略高，运行时间也略长。报告中的费用是估算值，不是账单。

## 测试对象与方法

- 扩展版：`F:\项目代码\SWE-agent-full`，官方完整版 SWE-agent 1.1.0、上游提交 `3ea751c087f32b16e039a2233dd6eefecef325d5`，本地 `wz-integration` 分支的 `sweagent/wz/` 扩展。原版对照使用同一份官方 `DefaultAgent`、`config/default.yaml` 和 `registry`、`edit_anthropic`、`submit` 工具包，未启用扩展的仓库提示、独立验证或补丁审批。
- 两组均使用同一真实模型、相同仓库提交、预先准备的同一 Docker 依赖镜像、最多 30 次模型调用和 0.25 美元估算费用上限。模型配置读取本地 `.env`，密钥不进入报告、Git 或 Docker 构建上下文。
- 模型配置名为 `openai/deepseek-v4-flash`，接口最终报告 `deepseek-flash`。按 [DeepSeek 官方定价](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)为此别名登记计费参数：峰时输入缓存未命中 0.30 美元/百万 token、缓存命中 0.006 美元/百万 token、输出 1.20 美元/百万 token。实际账单和优惠时段需以服务商记录为准。
- 题目来源是 [SWE-agent/test-repo Issue #1](https://github.com/SWE-agent/test-repo/issues/1) 与 [Issue #22](https://github.com/SWE-agent/test-repo/issues/22)，本地源仓库固定在 `7bef0c62cce60a2cb6df0c80f18b3054e1c23630`。两组从独立干净副本出发，Issue 正文由 GitHub 公开接口读取。没有创建 PR、推送代码或触发远程 CI。
- 扩展版在模型提交后检查改动文件、运行可信测试命令、把可修复问题反馈给模型，再由本次自动批准回调批准通过的补丁。自动批准只用于隔离评测副本；日常 `fix` 命令仍要求人工查看 diff 并确认。

## 逐题结果

| Issue | 扩展版 | 原版 | 独立功能检查 | 交付规则 |
| --- | --- | --- | --- | --- |
| #1：`missing_colon.py` 语法错误 | 17 次调用；73.48 秒；估算 $0.013228 | 10 次调用；44.52 秒；估算 $0.004132 | 原始代码失败；两组补丁均通过编译和 `division(23, 2) == 11.5` | 扩展版仅改 `src/testpkg/missing_colon.py`，通过；原版还改了 `tests/missing_colon.py`，不符合规则 |
| #22：`tribonacci.py` 算法错误 | 8 次调用；55.99 秒；估算 $0.004329 | 25 次调用；80.64 秒；估算 $0.012216 | 原始代码失败；两组补丁均通过 `n=0..7` 的预期值检查 | 两组均仅改 `src/testpkg/tribonacci.py`，通过 |
| 合计 | **2/2 可交付；25 次调用；129.47 秒；估算 $0.017556** | **1/2 可交付；35 次调用；125.16 秒；估算 $0.016348** | 两组均 2/2 功能通过 | 扩展版调用次数少 10 次（28.6%），费用估算高约 7.4%，耗时高约 3.4% |

扩展版 #1 的第一次提交同时改了源文件和测试文件，被 `test_modified:tests/missing_colon.py` 拦下。该原因作为观察结果回传模型；第二次提交撤销测试改动，仅保留源文件修复，随后独立验证通过。这说明“策略拒绝→观察反馈→再次修改→验证”在这次真实运行中确实发生。原版 #1 的补丁虽然通过功能检查，但修改已有测试文件，不能直接按本项目规则交付。

独立检查在全新的只读源码挂载容器中完成，强制 `PYTHONPATH=/repo/src:/repo`，避免误用镜像中预装的同名 Python 包，并将 `.pyc` 缓存写到临时目录。扩展版内部的可信测试也采用项目源码优先的导入路径。#1 的内部命令是 `python -m py_compile src/testpkg/missing_colon.py`，#22 是对 `tribonacci(0)` 的断言；上述逐题表中的额外断言则是评测后执行的独立检查。不要把“指定测试通过”理解成完整测试套件全绿。

## 运行过程发现并修复的问题

1. 旧项目的模型别名尚未进入完整版的 LiteLLM 价格表，首次真实调用虽能连通接口，却在费用计算处中断。已增加 `config/wz-model-prices.json`，只有命中该别名时才注册本地价格与能力信息，并用单元测试覆盖。
2. 早期独立检查会优先导入镜像预装包，可能造成假阳性。已让可信测试和额外检查优先加载任务仓库的 `src`，并用 Docker 集成测试验证该路径。
3. 在修复前的一次运行里，#1 因修改测试文件而直接结束，没机会撤回。现对“仅有测试文件改动”这一类可修复拒绝给出反馈并允许再次提交；最终正式运行记录了两次提交和成功撤回。其他策略违规仍按策略终止。

前面几次运行分别用于定位和修复上述问题，不进入本报告的正式分数。正式统计只采用最后一次扩展版运行和同条件的原版对照运行。

## 自动化检查与证据

- `tests/test_wz_extension.py`：**8 passed**，包括模型别名配置、完整版 Agent Loop 接入、真实 Docker/SWE-ReX 提交反馈和批准、入口、费用中断后恢复等。存在 9 条上游依赖或配置兼容性 warning，没有测试失败。
- 最终代码的 Ruff 检查和格式检查通过；`Dockerfile.wz` 构建出 `sweagent-wz:evaluated`，容器中的 `sweagent-wz --help` 可启动，并确认镜像内不存在 `/app/.env`。
- 评测原始结果：`C:\Users\34947\Documents\Codex\swe-agent-migration\real-eval-20261017-policy-feedback\results.json` 与 `C:\Users\34947\Documents\Codex\swe-agent-migration\real-baseline-20261017\results.json`；各任务目录另有轨迹、补丁和验证记录。
- 输入清单：`C:\Users\34947\Documents\Codex\swe-agent-migration\real-issues-20261017.json`。独立容器检查：`C:\Users\34947\Documents\Codex\swe-agent-migration\clean_validation_20261017.json`。
- 复现扩展版运行可在安装依赖、配置本地 `.env` 并启动 Docker 后执行：

  ```powershell
  cd 'F:\项目代码\SWE-agent-full'
  .venv\Scripts\python.exe -m sweagent.wz.run evaluate --manifest 'C:\Users\34947\Documents\Codex\swe-agent-migration\real-issues-20261017.json' --output '<新建的输出目录>' --step-limit 30 --cost-limit 0.25
  ```

  复现会再次调用付费接口，结果可能因模型随机性变化。上面的输入清单引用本机历史测试仓库，换机器时需要提供相同提交的本地副本。

## 解读边界和下一步

本次只有两个容易定位的小型 Python Issue，且每组只运行一次；没有覆盖大型仓库、多文件修复、Node 或混合项目，也没有按 SWE-bench 官方流程评测。结果适合证明真实模型接入、补丁验证和纠错反馈能工作，不能证明扩展版整体优于原版。若要回答面试中的“成功率提升多少”，应固定公开题集，进行多次重复运行，并统一统计解决率、可交付率、失败类别、真实账单与耗时。

`model_stats.instance_cost` 依据模型响应中的用量字段和本地峰时价计算；上游 `tokens_sent` / `tokens_received` 主要统计可见消息内容，不含全部工具参数和推理内容，**不应当作实际计费 token 数**。本次没有核对服务商账单，也未实测真实模型的断点恢复、远程草稿 PR 和 CI 状态查询。Docker 产品镜像的命令入口已验证，真实模型修复任务是在本机 Python 入口通过 SWE-ReX 容器运行，并非在产品镜像入口中完成。
