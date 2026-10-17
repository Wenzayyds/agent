# 完整版 SWE-agent 迁移说明

这个目录以官方完整版 SWE-agent 1.1.0（`3ea751c`）为底座，保留官方的 Agent Loop、模型适配、工具安装和执行、SWE-ReX 环境、轨迹记录。新增功能集中在 `sweagent/wz/`，没有替换官方核心模块。它与此前的 mini 版项目是两个独立目录。

| 原 mini 版里的功能 | 完整版里的处理方式 |
| --- | --- |
| Agent Loop、结构化工具调用、错误重问、Bash 执行和步骤轨迹 | 直接使用完整版现有实现，不移植 mini 版实现 |
| 按关键词提取仓库片段 | 移至 `sweagent/wz/repository.py`，作为初始提示；模型仍需自行核对代码 |
| 固定 Git HEAD 并创建任务副本 | 移至 `repository.py`；模型只修改副本，原仓库保持原样 |
| 识别依赖和测试命令、构建运行镜像 | 移至 `setup.py`；支持常见 Python 和 Node 项目，特殊项目仍需人工指定测试命令 |
| 提交后检查补丁、执行测试、失败反馈、人工审批 | 移至 `verification.py`；只覆写完整版的 `handle_submission`，测试失败时继续使用官方 Agent Loop 修复 |
| Issue 读取、草稿 PR、CI 状态查询 | 移至 `github.py`；只有明确加 `--publish-pr` 且补丁通过审批，才创建草稿 PR |
| 批量评测、完成任务跳过、未完成任务归档 | 移至 `run.py` 和 `runs.py`；每题保存模型统计、验证记录和运行时间 |
| 暂停后继续 | `sweagent-wz resume` 从费用上限等中断的运行读取历史和候选补丁，在新的 SWE-ReX 容器里继续 |

## 本地运行

需要 Python 3.11+、Git 和正在运行的 Docker。安装依赖：

```bash
python -m pip install -e .
```

把模型密钥放在本机环境变量中，或放在仓库根目录被 Git 忽略的 `.env` 中，并指定模型名称，例如 `MSWEA_MODEL_NAME` 或 `.env` 内的 `MODEL_NAME`。不要提交 `.env`。运行时会询问是否允许模型在任务副本中执行命令；测试通过后还会展示 diff 并请求批准：

```bash
sweagent-wz fix --repo /path/to/repo --task "修复这里的错误" --test-command "python -m pytest -q"
sweagent-wz fix --repo /path/to/repo --issue https://github.com/owner/repo/issues/123 --test-command "python -m pytest -q"
sweagent-wz resume --session /path/to/session
```

如果要创建草稿 PR，再给 `fix` 加 `--publish-pr --base-branch main`。这一步需要 Issue URL、GitHub 凭据，以及对目标仓库的推送权限；本项目迁移和测试期间没有调用它。

批量评测用 `sweagent-wz evaluate --manifest cases.json --output runs --model 模型名`。`cases.json` 是对象数组，每项可含 `id`、`repo`、`task` 或 `issue`、`base_commit`、`test_commands`。评测结果只统计实际运行的任务；单元测试里预设的模型回复不算真实模型成功率。

## Docker 运行

项目自己的镜像可用 `docker build -f Dockerfile.wz -t sweagent-wz .` 构建。完整版 SWE-agent 还会通过 SWE-ReX 启动任务容器，所以在 Linux 主机上运行这个镜像时，需要挂载 Docker socket 和待修复的仓库，例如：

```bash
docker run --rm -it -v /var/run/docker.sock:/var/run/docker.sock -v /path/to/repo:/workspace/repo:ro -v /path/to/runs:/workspace/runs -e MSWEA_MODEL_NAME -e OPENAI_API_KEY sweagent-wz fix --repo /workspace/repo --task "修复错误" --session /workspace/runs/task-1 --test-command "python -m pytest -q"
```

挂载 Docker socket 会让容器拥有主机 Docker 的管理权限，只能在可信环境运行。Windows 主机上的 Docker Desktop 挂载方式可能不同；本地 Python 运行是已经过 Docker 集成测试的路径。`Dockerfile.wz` 已构建，镜像的 `--help` 入口已启动验证；尚未用容器入口跑完整的真实模型修复任务。

## 已验证与边界

测试包含真实 Git 副本、补丁策略、批量任务状态，以及使用预设模型在真正的 SWE-ReX 容器中完成提交、失败反馈、测试、审批、入口运行和中断恢复。另用 DeepSeek 真实模型跑了两道公开小型 Issue，并与完整版官方 Agent 在同题、同模型下对照；结果、费用口径和局限见 [2026-10-17 测评报告](wz-evaluation-2026-10-17.md)。这两题不是代表性 Issue 数据集，不能推断总体成功率。没有做与 mini 版的同题对照。
