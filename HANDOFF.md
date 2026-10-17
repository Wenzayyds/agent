# 工作记录

## 2026-10-16 从 mini 版迁移到完整版 SWE-agent

- 本目录是官方完整版 SWE-agent 1.1.0（上游提交 `3ea751c087f32b16e039a2233dd6eefecef325d5`）的独立副本；本地分支为 `wz-integration`。旧项目 `F:\项目代码\SWE-agent` 保留，未复制其 Git 历史，也未向任何远程推送。
- 保留完整版原有 Agent Loop、工具接口、SWE-ReX、模型适配和轨迹模块；自己的增量集中在 `sweagent/wz/`。具体取舍、入口和边界见 `docs/wz-full-migration.md`。
- 新增独立仓库副本与检索提示、环境镜像准备、提交后的补丁策略/测试反馈/人工审批、Issue 和草稿 PR 接口、批量评测、费用中断后的恢复。
- 修改 `pyproject.toml` 增加 Typer 和 `sweagent-wz` 命令；增加 `.gitattributes` 维持工具脚本 LF，避免 Windows 克隆时 Bash/Python shebang 带入 CRLF。
- 增加 `Dockerfile.wz` 和 `.dockerignore`。镜像 `sweagent-wz:migration` 构建成功，`docker run --rm sweagent-wz:migration --help` 通过；容器运行任务时需要挂载 Docker socket，以便完整版的 SWE-ReX 启动任务容器。
- 测试使用 `tests/test_wz_extension.py`，7 项全部通过。预设模型的 Docker 集成测试证明运行流程，不代表真实模型解决 Issue 的成功率。尚未用真实模型进行正式评测，亦未提交或推送本地分支。

## 2026-10-17 DeepSeek 真实模型测评

- 从 `F:\项目代码\wzAgent\.env` 复制模型配置到本仓库根目录 `.env`；Git 与 Docker 构建上下文均忽略该文件。没有把密钥写入追踪文件、报告或聊天内容。
- 为旧配置中的 DeepSeek 模型别名增加本地价格注册，运行时加载根目录 `.env`；评测命令支持模型调用次数和估算费用上限。
- 修复可信测试误用镜像已安装包的问题；只修改已有测试文件的补丁现在会收到拒绝原因，Agent 可撤回修改后再次提交。
- 两道公开 Issue 的正式真实模型运行：扩展版 2/2 可交付，25 次 API 调用、129.47 秒、峰时估算 $0.017556；同条件的官方 DefaultAgent 功能检查 2/2 通过，但一题改了已有测试文件，按交付规则为 1/2，可见 35 次调用、125.16 秒、估算 $0.016348。样本太小，不能宣称总体优于原版。
- 独立干净容器检查：原始代码两题失败，扩展版和原版补丁两题均通过；扩展版两题均仅修改源文件。8 项扩展单元/集成测试通过，详细方法、路径与局限见 `docs/wz-evaluation-2026-10-17.md`。
- 未创建或推送远程分支、PR；没有核对真实账单，也未测远程 CI 和真实模型断点恢复。
- 最终代码 Ruff 检查、格式检查、diff 检查通过；代码风格修复后 8 项测试再次全部通过。最终 `sweagent-wz:evaluated` 镜像构建成功、命令入口可启动，镜像内无 `/app/.env`。

## 2026-10-17 独立远程分支

- 按用户要求，完整版项目以当前文件快照创建无上游提交历史的本地 `SWE-Agent` 分支，目标远程改为 `https://github.com/Wenzayyds/agent.git`，后续在该分支维护。`.env` 与 `.venv` 保持忽略，保留 LICENSE 与上游来源说明。
