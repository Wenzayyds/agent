# wzAgent 功能迁移

## 基础代码与范围

- 上游：SWE-agent/mini-swe-agent，2.4.6，提交 `04d809ceab9df28f9adaed044884180159172930`。
- 本地：`F:\项目代码\mini-swe-agent`，分支 `wzagent-migration`；网络原因采用浅克隆，保留 origin 和上游许可证。
- 原项目 `F:\项目代码\wzAgent` 保持不变。禁止 sub agent。
- 目标：保留上游 DefaultAgent、Model 和 Environment 协议，通过独立扩展增加可验证的软件修复能力。

## 迁移前评分

这是针对当前面试准备的工程判断，不是客观性能测评。各项按 1–10 分，综合分 = Agent 核心技术×40% + 面试可解释性×30% + 可验证性×20% + 迁移经济性×10%。经济性越高表示成本越低。8 分及以上优先迁移；上游已有能力仅复用，不重复开发。

| 功能 | 核心 | 面试 | 验证 | 经济性 | 综合 | 决定 |
|---|---:|---:|---:|---:|---:|---|
| 测试反馈、失败分类、有限重试 | 10 | 10 | 10 | 8 | 9.8 | 迁移，在提交前验证并反馈原 Agent Loop |
| 仓库隔离与可审查 Patch | 9 | 10 | 10 | 8 | 9.4 | 迁移，使用独立本地克隆，保留源目录 |
| 补丁路径/规模/敏感文件策略 | 9 | 9 | 10 | 8 | 9.1 | 迁移，提交检查含新文件、删除和二进制 |
| 可复现评测与失败用例 | 9 | 10 | 10 | 6 | 9.2 | 迁移为离线集成验证，区分控制流与模型能力 |
| Docker 执行限制 | 9 | 9 | 8 | 7 | 8.6 | 复用上游 Docker，增加隔离参数 |
| 文件检索与关联测试提示 | 8 | 9 | 9 | 8 | 8.5 | 迁移为初始提示，仍允许 Agent 自主搜索 |
| 人工审批与审计记录 | 8 | 9 | 9 | 8 | 8.5 | 迁移为运行前确认与最终补丁确认，复用轨迹 |
| Issue URL 入口 | 7 | 8 | 9 | 9 | 7.9 | 作为低成本入口补充，支持本地任务文本 |
| 轨迹、模型适配、成本与步数预算 | 9 | 9 | 9 | 10 | 9.1 | 上游已有，直接复用 |
| 独立 Planner/Editor 固定流水线 | 6 | 7 | 8 | 4 | 6.5 | 不迁移，避免覆盖上游逐步决策机制 |
| SQLite 队列、RBAC、会话认证 | 5 | 6 | 8 | 3 | 5.7 | 暂缓，当前为单用户 CLI |
| 自动 GitHub PR 与外部写入 | 5 | 6 | 5 | 3 | 5.1 | 暂缓，先导出 Patch |
| Web 控制台、TUI、SSE | 3 | 5 | 7 | 3 | 4.4 | 暂缓，演示使用 CLI 和轨迹 |
| 旧聊天 RAG、语义缓存、网页搜索 | 3 | 4 | 6 | 4 | 4.0 | 不迁移，与修复主线关联弱 |

## 迁移设计

- 继承 DefaultAgent，只扩展动作执行与提交验证；继续使用上游模型适配和线性消息历史。
- 独立克隆采用源仓库 HEAD，不复制未提交修改，不创建 PR，不自动把 Patch 写回原仓库。
- 提交须同时满足：非空有效补丁、策略检查、用户指定的测试实际通过、最终人工确认。空测试列表不得判成功。
- 仅单测/语法失败可进入有限修复；依赖、超时、权限、环境等故障终止。失败日志作为 Observation 返回原循环，不重置模型历史、累计成本或步数。
- Docker 是默认执行环境；本机模式必须显式选择，仅用于可信仓库。补丁策略属于提交检查，不是任意 Shell 的安全沙箱。
- 不迁移旧的 JSON 编辑器：mini 本身通过 Bash 编辑，保留其架构，迁移的是提交约束和测试反馈。
- 不声称达到 SWE-bench 成绩；离线确定性模型仅用于验证真实 Git/命令/测试链路。

## 当前环境

- Python 3.14.2；已在本项目 `.venv` 安装上游依赖、pytest、pytest-asyncio、ruff 和 pip。
- Docker CLI 存在，但 Docker Desktop Linux 引擎未启动。Docker 真机测试需如实记录为未验证。
- 所有迁移与检查结果在此文件补充。

## 已完成迁移与代码映射

| wzAgent 来源 | 基础代码上的实现 | 取舍 |
|---|---|---|
| services.py: run_after_approval / build_editor_prompt / classify_test_failure | agents/verified.py: VerifiedAgent.verify_submission / classify_failure | 在上游 DefaultAgent 中保留消息历史；不重置累计成本、步数。失败后在当前补丁上继续修复，不沿用旧的每轮撤销并重新生成 JSON 编辑模式 |
| application.py: LocalRepositoryAdapter | utils/wz_repository.py: Repository.prepare | 独立本地克隆并复制 Git 对象，避免 worktree 共用源仓库 Git 元数据；源仓库未提交内容不进入副本 |
| services.py: retrieve_context / associate_test_files | utils/wz_repository.py: Repository.context | 文件名、内容关键词、中文配置提示和源文件/测试关联；仅提供初始提示，Agent 仍可自主检索 |
| services.py: safe_patch_target / validate_patch_diff / review_patch | utils/wz_repository.py: Repository.review | 固定基线和独立索引，合并检查已暂存、未暂存、新增、删除文件；限制规模、二进制、敏感路径、疑似密钥、符号链接、现有测试修改 |
| services.py: run_sandbox_command | environments/wz.py: WzLocalEnvironment / WzDockerEnvironment | 复用上游执行类，默认 Docker；Windows 本机模式使用 Git Bash，提交标记交给 VerifiedAgent 处理 |
| 审批及审计表 | run/wz.py: fix / confirm_patch；VerifiedAgent.serialize | 单用户交互确认，扩展上游轨迹保存测试命令、退出码、失败分类、补丁 SHA256、耗时和审批结果，不搬 SQLite/RBAC |
| eval_fixtures.py / eval_harness.py | run/wz.py: demo / run_demo_case；tests/test_wz.py | 三组真实 Git/编辑/测试案例，以官方 DeterministicModel 验证执行机制；不把预设响应结果当作 LLM 评测成绩 |

### 实际新增与复用

- 新增 4 个运行模块、1 个测试模块和本 HANDOFF；只给原 `.gitignore` 增加 `/work/`。
- 上游 `agents/default.py`、Model Adapter、Environment 基础实现、README、许可证均未修改。
- 提交成功状态为 `Verified`；只有显式测试命令通过、Patch 没有在测试或审批期间变化、且用户确认后才生成 `approved.patch`。
- 测试失败可回流原 Agent Loop；依赖缺失、未知错误、权限、命令缺失、超时和“收集到 0 个测试”会终止。编译/单测失败最多额外修复 2 次。
- 不使用 shell 字符串黑名单冒充安全边界。用户指定测试命令属于可信配置，Agent 仍可执行任意 Bash；本地模式仅用于可信项目。
- 现有测试文件不能修改，可新增测试。这是本次面试演示的保守提交策略，不适用于所有测试维护任务。
- Docker 仅挂载副本的工作目录，不挂载 Docker socket 或源仓库。Git 元数据在副本目录外，容器内不提供可操作的 Git 仓库。

## 如何运行

在 PowerShell 中进入本项目。以下示例均不修改原 wzAgent。

```powershell
Set-Location 'F:\项目代码\mini-swe-agent'
$env:MSWEA_GLOBAL_CONFIG_DIR = "$PWD\work\config"

# 无 API 调用、无费用的三组离线演示；输出目录必须尚不存在。
.\.venv\Scripts\python.exe -m minisweagent.run.wz demo --output work\my-first-demo

# 查看真实模型入口。
.\.venv\Scripts\python.exe -m minisweagent.run.wz fix --help
```

真实模型修复示例，先配置自己的模型和 Key。默认保留上游成本统计；自定义端点若没有价格配置，应按上游方式注册模型价格，不能把 0 元当作真实成本。

```powershell
$env:OPENAI_API_KEY = '<你的 API Key>'
$env:MSWEA_MODEL_NAME = 'openai/<你的模型名>'
# 如使用兼容接口，可另外设置 OPENAI_API_BASE。

.\.venv\Scripts\python.exe -m minisweagent.run.wz fix `
  --repo 'F:\项目代码\mini-swe-agent\work\demo-verified\blank_name\source' `
  --task '修复 app.py：空白姓名应返回 None，正常姓名转为小写' `
  --test-command 'python -m unittest -v' `
  --environment local
```

- 启动时会显示任务、环境和测试命令，用户确认后才调用模型执行。
- 测试通过后显示完整 Diff，用户确认才导出批准后的 Patch。不会自动应用回源仓库或创建 PR。
- 可以用 `--issue https://github.com/OWNER/REPO/issues/NUMBER` 替换 `--task`；仍需提供对应本地 `--repo`。当前 Issue 入口读取公开标题与正文，不自动获取私有仓库凭据。
- 切换 `--environment docker --image <已安装项目测试依赖的镜像>` 可使用 Docker。默认镜像 `python:3.11-slim` 适合标准库 unittest，不包含 pytest 或项目依赖；禁网时不会自动安装依赖。
- Linux 容器默认使用宿主非 root UID/GID；root 宿主回退至 65532，需要预先保证副本目录的非 root 写权限。当前实测平台是 Windows/Git Bash，Linux/Docker 编辑权限未做真机验收。
- 每次任务在源目录同级 `mini-wz-runs/` 下生成独立 session，也可用 `--session` 指定新的目录。失败保留副本和轨迹，便于定位问题；需要撤销时直接放弃副本，不改源仓库。

## 验证结果（2026-10-05）

- 三组离线演示：`work/demo-verified/summary.json`。blank_name、inclusive_range、absolute_value 均基线失败，经过 1 次反馈修复后通过，均保持源仓库不变。每组 4 次确定性模型调用、无外部模型请求。
- 最终回归：48 passed、1 skipped、34 deselected。包括本次全部 35 个测试项（34 通过，Docker 1 项跳过），以及上游 14 个预算/模板/格式错误测试。未宣称运行全部上游测试。
- Ruff 检查和格式检查通过，新增 Python 文件编译检查通过。
- 测试覆盖：成功修复、错误分类、超时、步数/成本预算不重置、重试耗尽、用户拒绝、测试/审批期间修改补丁、空提交、空测试、零测试收集、受保护路径、删除测试、二进制、新文件、源仓库未提交内容隔离。
- Docker daemon 当前不可用，Docker 执行测试按条件跳过；仅检查了构造参数，未宣称容器端到端通过。
- 未使用真实 API Key 进行模型验收，尚无真实 Issue 成功率、token 节省率或 SWE-bench 分数。

复现最终回归：

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_wz.py tests/agents/test_default.py `
  -k 'test_wz or step_limit_enforcement or cost_limit_enforcement or render_template_model_stats or wall_time_limit_template_vars or repeated_format_errors_terminate_cleanly or format_errors_count_against_cost_limit' `
  -q --basetemp=work/pytest-my-run
```

Git Bash 在本次工具沙箱中被 MSYS 进程通信权限拦截，因此测试经工具授权在沙箱外运行。所有测试只操作新建临时样例；原 wzAgent 没有修改。

## 面试可以准确描述的改进

“基于 mini-SWE-agent 2.4.6 扩展软件修复流程，保留原有模型驱动的 Agent Loop。在模型提交阶段加入固定基线的补丁检查、独立测试和人工确认；将可修复的测试失败作为 Observation 回传，并保留累计预算。通过独立仓库副本保护源工作区，用离线集成案例验证成功及失败分支。”

可以展示对比：上游提交标记表示 Agent 自行结束；扩展中提交标记先触发独立验证，失败时继续同一条消息历史，只有验证和审批均通过才接受补丁。不要将“48 个测试通过”表述成“48 个真实 Issue 修复成功”。

## 2026-10-06 Docker 运行方式

根目录新增 `Dockerfile` 和 `.dockerignore`。镜像装有 Python 3.11、Git、ripgrep 与项目依赖；默认入口是 `python -m minisweagent.run.wz`。容器使用非 root 用户，`/runs` 保存任务副本与补丁。构建上下文排除 `.git`、虚拟环境、缓存和本地 `.env`。

构建阶段默认使用可访问的阿里云 PyPI 镜像；如果该镜像不可用，可通过 `docker build --build-arg PIP_INDEX_URL=https://pypi.org/simple ...` 覆盖。安装的包仍由 `pyproject.toml` 声明。

在 `F:\项目代码\SWE-agent` 中构建并先运行不需要模型凭据的离线演示：

```powershell
docker build -t swe-agent:wz .
docker volume create swe-agent-runs
docker run --rm -it --mount type=volume,source=swe-agent-runs,target=/runs swe-agent:wz demo --output /runs/demo-001
```

真实修复任务示例。模型访问所需的 `OPENAI_API_KEY`、`MSWEA_MODEL_NAME` 应在当前 PowerShell 环境中配置，Docker `-e` 只转发变量；如果使用兼容端点，可以另加 `-e OPENAI_API_BASE`。输入 Git 仓库以只读方式挂载，任务会复制 HEAD 到 `/runs/issue-001`。该 session 路径必须尚不存在，换任务时请换新名字。

```powershell
docker run --rm -it `
  --mount "type=bind,source=F:\项目代码\wzAgent,target=/workspace/repo,readonly" `
  --mount type=volume,source=swe-agent-runs,target=/runs `
  -e OPENAI_API_KEY -e MSWEA_MODEL_NAME `
  swe-agent:wz fix `
  --repo /workspace/repo `
  --session /runs/issue-001 `
  --task "修复一个明确的代码问题" `
  --test-command "python -m unittest -v" `
  --environment local
```

这里的 `--environment local` 是指 Agent 在已经启动的应用容器里执行命令，不依赖宿主 Docker Socket。默认 `--environment docker` 用于直接在宿主启动 CLI 时再创建隔离容器；容器内无需嵌套 Docker。模型密钥不会传入本机模式启动的工具命令；工具执行仍处在应用容器内。指定的测试命令必须适合挂载仓库，并且容器镜像已安装其测试依赖。没有测试依赖时，程序会报告失败，不会假装成功。

本机实际验证：Docker Desktop Linux 引擎 29.1.3；`docker build` 使用本地 `python:3.11-slim` 基础镜像和阿里云 PyPI 镜像安装依赖后成功生成 `swe-agent:wz`。用非 root 容器只读挂载 `F:\项目代码\SWE-agent`，可读取 Git HEAD。容器以 `--network none` 运行三组离线修复案例，均为 `Verified`、各修复 1 次、源仓库未改动。宿主机新源码的 pytest 结果为 36 passed；Ruff 检查与格式检查通过。真实模型 API 调用仍未实测。

容器内执行本机模式命令时，`WzLocalEnvironment` 只传递运行所需的基本环境变量，模型 Key 与 GitHub Token 不传入工具命令；对应集成测试已通过。构建阶段使用 `DOCKER_BUILDKIT=0` 以利用本机缓存的 Python 基础镜像；普通环境下可直接运行上方 `docker build` 命令。
