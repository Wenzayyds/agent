# Pi Enhanced 联合集成交接

## 范围与来源

唯一开发目录为 F:/codex_worktrees/pi-enhanced-integration-9f44c107d。分离检出的共同基线为 9f44c107de607b73d4cd822455389c7e90b366cd。原仓库及两个开发工作树只读。本文记录 Memory 与 Knowledge/RAG 在该基线上的联调。

| 来源 | 基线上的工作区状态 | 合并处理 |
| --- | --- | --- |
| F:/项目代码/pi-agent | 29 项已跟踪修改、42 项历史删除、41 项未跟踪文件，暂存为空 | 独立保存状态和现存改动散列，用于核对。历史删除原样留在原工作区。 |
| F:/codex_worktrees/pi-memory-v3-adapters-9f44c107d | 21 项已跟踪修改、22 项未跟踪文件 | 导入 Memory 五类记忆、SQLite 迁移与 outbox、Qdrant、E5、Context 记忆读取、评测及测试。 |
| F:/codex_worktrees/pi-knowledge-rag-9f44c107d | 8 项已跟踪修改、35 项未跟踪文件 | 导入 Knowledge 扩展、分块与文档访问策略、独立 SQLite、Docling、工具、包注册、评测、测试和三个二进制夹具。 |
| F:/codex_worktrees/pi-v3-task-evidence-9f44c107d | 35 项已跟踪修改、3 项未跟踪文件 | V3.1 的 Task、Sandbox 及 Runner 证据和 V3.2 相关的 Context 输出截取、原文恢复仍在开发。此轮审计了共用的 TaskReader 和 Context 接入点，使用共同基线运行回归。 |

未发现独立登记的 V3.2 工作树。Task Evidence 树中的 Context 改动集中在 src/context/offload.ts 和 src/context/tool-output.ts。Memory 增量位于 src/context/memory-source.ts。后续接入 V3.1 时应核对 TaskReader 的 get/getActive、项目及会话 ID、活动分支和任务完成事件。V3.2 接入时需核对 MemoryInjectionResult.errorCode 到 Context 诊断的传递、记忆预算和分页恢复。当前交付只包含用户指定的两个开发树，其他工作树的实现和历史证据保持原样。

两个开发树合计 78 个不同路径。8 个重叠文件逐字节一致，包括 VECTOR_CONTRACT.md、共享 E5/Worker/Qdrant 的 3 个 TypeScript 文件、Python 的 pyproject.toml、worker.py、protocol.py 及 e5_embedder.py。审查了协议、生命周期和包入口后直接保留一致版本。Memory 保留旧导入路径，Knowledge 引用公共层。合并增量使用原文件字节，DOCX 和 PDF 夹具也按字节导入。[输入清单](.artifacts/integration/inputs.json) · [Memory 输入](.artifacts/integration/input-memory.zip) · [RAG 输入](.artifacts/integration/input-rag.zip)

固定上游源码、许可证及采用机制见 [Memory M1–M10](packages/pi-enhanced/docs/memory-v3.md) 和 [Knowledge K0–K6](HANDOFF.md)。[公共向量契约](VECTOR_CONTRACT.md) 描述了 E5 的模型身份与批量接口、Worker 所有权、Qdrant payload、公用错误和检索回退。

## 运行行为与验收

| 场景 | 集成行为及验证 |
| --- | --- |
| 独立启停和旧配置 | 在同一 Pi 会话加载两个生产扩展，验证关闭两者、仅 Memory、仅 Knowledge 和同时启用四种组合。Knowledge 默认关闭，显式启用后默认 FTS5。Memory 旧配置只给出 semantic 或 hybrid 时继续使用 TF-IDF+SVD。两个模块各自管理存储和工具启停。 |
| 共用 E5 与 Qdrant | 使用同一固定 revision 的 multilingual-e5-small 模型及权重缓存，384 维，CPU 推理。两个模块各自拥有 Worker，在同一个仅监听回环的 Qdrant 实例使用 pi_enhanced_memory_v3 与 pi_enhanced_docs_v1。两边都以各自的 SQLite 为权威，并使用各自的重试、版本和清理规则。 |
| 同轮检索与 Context | Pi 原生工具循环在同一轮请求分别获取已验证记忆及用户批准外发的文档。Context 通过 ScopedMemoryReader 注入低信任项目记忆。来源文件变更后，直接检索和 Context 同时屏蔽该记忆并移除上一条注入。撤销项目信任后，已取得的 Memory 和 Knowledge 句柄也拒绝继续披露。 |
| 停机、撤销、修订和恢复 | 真实 Qdrant 停机时逐一验证 FTS5 回退。停机期间归档记忆、撤销文档外发权限并提交新文档版本。恢复后重试文档待激活版本。重新写入两种旧 Point，验证过期内容不会通过 SQLite 核验，并由各自对账清理。 |
| 降级与隔离 | Memory 独立测试覆盖模型缓存缺失继续使用 FTS5、HTTP 429 分类、项目和任务过滤、跨语言访问及集合重建。离线 Worker 无网络。Knowledge 和 Memory 的集合、数据库及后台操作分别核验。 |
| 回收与 Sandbox | 关闭 Memory 后原 Knowledge Worker 仍能编码和检索，进程 ID 保持一致。随后回收两个 Worker、专用容器、Compose 网络及命名卷。Sandbox 的已有工具白名单继续适用。 |

集成额外代码位于 [Memory/Knowledge 联合测试](packages/pi-enhanced/tests/integration/memory-knowledge-integration.test.ts)。[Task 崩溃恢复测试](packages/pi-enhanced/tests/e2e/task-crash-recovery.test.ts) 通过测试文件 URL 定位子进程夹具，子进程在自己的临时项目中运行。[评测遥测测试](packages/pi-enhanced/tests/unit/evaluation-telemetry.test.ts) 把导入地址转成标准 file URL。这两处修复覆盖仓库根目录和 npm workspace 包目录。[包 README](packages/pi-enhanced/README.md) 同步六个模块入口、旧配置、E5 选项和独立集合说明。

## 复现命令

从集成工作树根目录执行。使用 Node 24 和预置的 Docker 镜像。Qdrant 版本及摘要在 Compose 中固定。E5、Docling 和 pytest 本次使用的镜像 ID 见 .artifacts/integration/docker-images.txt。模型目录数据是被 Git 忽略的构建输入，本次复用同基线已生成的公开目录缓存。干净环境可用 npm run hydrate:model-data 生成。模型目录元数据生成与本地 E5 推理不涉及在线模型推理。

    npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
    npm run hydrate:model-data
    npm run build:offline
    $env:PI_MEMORY_V3_DOCKER='1'
    $env:PI_ENHANCED_KNOWLEDGE_QDRANT='1'
    $env:PI_ENHANCED_KNOWLEDGE_DOCLING='1'
    $env:PI_ENHANCED_INTEGRATION_DOCKER='1'
    $env:PI_ENHANCED_RUN_EXTERNAL_MCP='0'
    $env:PI_ENHANCED_RUN_SERENA_DOCKER='0'
    $env:PI_TEST_PYTEST_IMAGE=docker image inspect pi-enhanced-pytest:local --format '{{.Id}}'
    npm run test --workspace @wz-agent/pi-enhanced -- tests/unit tests/integration tests/e2e --exclude '**/.artifacts/**' --maxWorkers=1 --testTimeout=30000 --reporter=dot --reporter=json "--outputFile=$PWD/.artifacts/integration/full-vitest.json"

类型、静态、包和容器检查可按下列命令复现。smoke:docker 会生成 packages/pi-enhanced/docs/batch-f-sandbox-smoke.json。本次将新报告移到 .artifacts/integration 保留证据。

    npm run check --workspace @wz-agent/pi-enhanced
    npm run check:evaluation --workspace @wz-agent/pi-enhanced
    node node_modules/typescript/bin/tsc --noEmit -p .artifacts/integration/tsconfig.extra.json
    npm run check:pinned-deps
    npm run check:runtime-deps
    npm run check:ts-imports
    npm run check:entry-graphs
    npm run check:install-lock:coding-agent
    npm run check:browser-smoke
    npm run check:model-data
    npm run check:pack --workspace @wz-agent/pi-enhanced
    npm run evaluate:real-agent --workspace @wz-agent/pi-enhanced -- --preflight
    docker compose -f packages/pi-enhanced/fixtures/memory-v3/compose.yaml config --quiet
    npm run smoke:docker --workspace @wz-agent/pi-enhanced
    git diff --check

Python 在现有 E5 镜像中用 pytest 执行，挂载只读源码并设置 --network none。Knowledge Python 解析通过独立 Docker 集成用例验证，涵盖 HTML、DOCX、带文本 PDF 和无文本 PDF。

    $source=(Resolve-Path 'packages/pi-enhanced/python/memory-intelligence').Path
    $image=docker image inspect pi-memory-v3-e5:local --format '{{.Id}}'
    docker run --rm --network none --read-only --tmpfs '/tmp:rw,noexec,nosuid,nodev,size=64m' --mount "type=bind,source=$source,target=/repo,readonly" --env PYTHONPATH=/repo/src --env PYTHONDONTWRITEBYTECODE=1 --workdir /repo $image python -m pytest -q -p no:cacheprovider tests

## 实测结果

| 检查 | 结果 |
| --- | --- |
| TypeScript 完整包目录回归 | 68 个测试文件。416 通过、0 失败、29 跳过，耗时 843.03 秒。联合用例 6/6、Knowledge 30/30、真实 pytest 15/15。两个路径夹具在包目录 17/17，另从仓库根目录复测 17/17。 |
| 测试身份清单 | 445 项，保留基线 243 项。身份清单 SHA-256 为 ecb625bbc0fb963a6bbb6cc68192a5708c209b74c2ed3539d8dd1ff0294cfa5a。 |
| Python | Memory 无网容器 18/18。Knowledge Python 语法通过，4 项真实 Docling 转换测试均计入 TypeScript 回归。 |
| Docker | Memory 与 Knowledge 各自的真实 E5/Qdrant 测试及联合停机恢复均通过。Compose 配置、Sandbox 烟测、无网访问约束和临时资源回收检查通过。 |
| 静态与构建 | 离线构建、仓库与评测 TypeScript、专项夹具和评测类型检查、固定依赖、运行时依赖、TS 导入、入口图、安装锁、浏览器边界、模型目录、只读预检、打包范围与 Git 空白检查通过。包中确认包含两个扩展、共享 E5/Worker/Qdrant 和两个 Python 入口。 |
| Biome | Memory、Knowledge、共享向量源码和 Context 的 Memory 源共 40 个文件通过严格检查，联合测试通过专项检查。全仓只读扫描共检查 1645 个文件，报 10 条基线错误及 6 条信息，涉及 10 个未改动文件。未运行全仓自动改写。 |

跳过项来自既有测试条件，包括 Batch J 1 项、Batch N 3 项、外部 MCP 2 项、SWE-bench 策略 17 项和 SWE-bench Stub 6 项。完整包目录回归运行在 Windows 宿主及 Docker Desktop Linux 容器。独立 Linux CI 及依赖公共 Astropy 镜像的 Docker 证据门槛未运行。V3.1/V3.2 的工作中增量仍需单独合并后验证。

现有 SWE pytest 夹具运行后留下一个本次启动的 Sandbox 容器。核对创建时间、容器 ID 和临时绑定目录后定向回收。此前存在的同名前缀容器及 Memory 开发树的命名卷原样保留。最终核对两个模块及联合夹具本次使用的容器、网络、数据卷、临时目录均无残留。[运行结果](.artifacts/integration/full-vitest.json) · [测试身份清单](.artifacts/integration/test-manifest.json) · [根目录复测](.artifacts/integration/root-cwd-fixtures.log) · [Python](.artifacts/integration/python-memory.log) · [Sandbox](.artifacts/integration/docker-smoke.json) · [全仓 Biome](.artifacts/integration/biome-repo.log) · [资源核对](.artifacts/integration/resource-verification.json)

## 固定检索集

用合并后的同一份源码在本机串行复跑，两组各用独立容器和索引。下表的查询延迟为预热 P50/P95，单位毫秒。

| 语料和模式 | Recall@5 | MRR@5 | P50 / P95 |
| --- | ---: | ---: | ---: |
| Memory FTS5 | 52.4% | 0.524 | 3.15 / 6.16 |
| Memory TF-IDF+SVD | 76.2% | 0.762 | 26.19 / 50.14 |
| Memory E5 + Qdrant | 95.2% | 0.843 | 45.72 / 56.88 |
| Memory FTS5 + E5 + Qdrant | 95.2% | 0.843 | 41.40 / 51.52 |
| Knowledge FTS5 | 75.0% | 0.750 | 0.37 / 0.68 |
| Knowledge E5 + Qdrant | 100.0% | 0.850 | 19.38 / 54.65 |
| Knowledge FTS5 + E5 + Qdrant | 91.7% | 0.833 | 22.74 / 54.40 |

Memory 的 24 个查询及 Knowledge 的 14 个查询各重复三次，作用域误命中均为 0。Memory 两种 E5 模式的首次文本编码耗时为 5.04–5.13 秒，预热查询编码中位数为 13.0–13.5 ms，Worker 约 608 MiB。Knowledge 首次编码约 5.15 秒，预热查询编码中位数 15.5 ms。原始 JSON 记录了资源、分层或逐查询结果。此次评测仅衡量检索和资源开销，Agent 工程链路使用本地 Stub 验证。

    node packages/pi-enhanced/benchmarks/memory-v3/evaluate.ts --stratified
    node packages/pi-enhanced/benchmarks/knowledge/evaluate.ts
    node node_modules/vitest/dist/cli.js --run packages/pi-enhanced/tests/e2e/task-crash-recovery.test.ts packages/pi-enhanced/tests/unit/evaluation-telemetry.test.ts --maxWorkers=1 --reporter=dot
    node --experimental-strip-types packages/pi-enhanced/scripts/ci/test-manifest.ts .artifacts/integration/full-vitest.json packages/pi-enhanced/docs/version-freeze-results.json .artifacts/integration/test-manifest.json

[Memory 评测原始数据](.artifacts/integration/memory-stratified.json) · [Knowledge 评测原始数据](.artifacts/integration/knowledge-docs-v1.json)

## 固定源码快照

快照包括相对共同基线的全部 82 条路径、已跟踪文件的二进制 Git patch 和每个文件的 SHA-256。解压后将 files 目录中的内容覆盖到基线 9f44c107de607b73d4cd822455389c7e90b366cd 的干净 worktree 即可重现。两个输入快照保留 README 的原字节和双方全部已跟踪、未跟踪文件。除合订的 README 外，另外 77 个输入文件均与来源一致。

交付前重新比对四个只读工作区的 Git 状态和现存改动散列。原仓库仍保留全部 42 项历史删除，原仓库和两个来源工作树的暂存区均为空。本轮未暂存、提交、推送或调用付费模型。

[源码快照](.artifacts/integration/pi-enhanced-integration-9f44c107d-source.zip) · [SHA-256](.artifacts/integration/pi-enhanced-integration-9f44c107d-source.zip.sha256) · [逐工作树核对](.artifacts/integration/source-verification.json)

## 独立 QA B1-04 修复

首版快照的 SHA-256 是 97a693c306d0284aab4c11e9c4a8005bf8f128c8837e17c77599e846a1c0483c。独立 QA 使用本机 HTTP Stub 收集实际请求体。首次检索获授权，随后撤销同一文档的外发权限。旧版本虽然已从新检索结果消失，旧 ToolResult 的合成标记仍在两条请求中各出现一次，共 52 字节。集成树增加的回归测试也在修复前重现了该问题。

Knowledge 的原生工具结果现在仅在会话中保留分块 ID 及检索元数据。发送每条模型请求前，扩展在 context_with_system 阶段为历史和当前的 Knowledge 工具结果逐个查 SQLite，核对当前项目与会话、项目受信任状态、文档版本及外发权限。允许的内容从当前数据库重新生成，撤销或退役的分块不提供正文、标题、路径或行号。保留工具调用配对。旧版历史中的完整 Knowledge 工具结果可提取引用并使用同一核验规则，无法解析的旧结果使用占位文本。该机制不改写旧会话文件中此前保存的明文。

从独立 QA 树读入 B1 用例，在集成树内复测。只调整副本的导入路径和 Vitest 配置，断言和 HTTP 请求采样保持原样。B1-01 至 B1-05 五项通过。B1-04 两条请求中已撤销标记出现 0 次、0 字节。新增回归用例还覆盖历史 read 结果、同一批中保留授权的另一份文档、项目撤销信任、旧版会话结果，以及重新授权后旧修订仍被屏蔽。

    node node_modules/vitest/dist/cli.js --run packages/pi-enhanced/tests/integration/knowledge-history.test.ts packages/pi-enhanced/tests/integration/knowledge-tools.test.ts packages/pi-enhanced/tests/integration/memory-knowledge-integration.test.ts --maxWorkers=1 --reporter=verbose
    node node_modules/vitest/dist/cli.js run --config .artifacts/integration/b1-qa-replay/vitest.config.ts --maxWorkers=1 --reporter=verbose

第二条命令需将 PI_QA_EVIDENCE 设为集成树中 .artifacts/integration/b1-qa-replay 的绝对路径。修复只改动 Knowledge 运行时代码和对应夹具，SQLite Schema、向量索引、V3.1/V3.2 源码及工具沙箱权限沿用现有实现。已发送给模型的正文或独立产生的摘要不属于 Knowledge 的工具历史回放。与 V3.2 合并后仍需验证 Context 总预算对最终回填内容的计算。

[新增回归](packages/pi-enhanced/tests/integration/knowledge-history.test.ts) · [修复前复现](.artifacts/integration/b1-04-before.log) · [独立 B1 复测](.artifacts/integration/b1-qa-replay/b1.jsonl) · [联合定向回归](.artifacts/integration/b1-04-final-focused.log)

## B1-04 最终集成

在集成树恢复独占写入后，核对并保留已有的请求级权限实现。上节的 context_with_system 方案是隔离副本及首轮 B1 复测使用的过渡版本。本节描述最终集成源码。前一次全量回归读取了混合版本，出现三项失败。其日志保留用于追溯，最终结果以本节对应的冻结源码和复测报告为准。

Knowledge 工具只交付带文档 ID、语料库、分块 ID、修订和外发策略的引用。Pi 在会话投影、派生摘要与发送阶段分别应用请求策略。转交支持权限检查的传输前，根据当前项目和 SQLite 中的授权、修订重新核对正文，并记录外发裁决。旧工具历史、派生助手内容和 Context 恢复路径按来源约束过滤。未经授权的分块省略后，保留模型请求中的工具调用配对。缺少可执行该检查的传输能力时，仅发送独立的会话内容。已经由接收端收到的请求保留审计记录，随后的请求重新核验。

本次保留的改动涉及 Knowledge 服务、工具和请求策略，Pi Agent 的请求封装、会话压缩、分支摘要，及相关模型传输。Context 的 offload 加入了文档来源检查。后续合入 V3.2 时需将该检查和 V3.2 的诊断预览、分页恢复放在同一条读取链路验证。两条 V3.1/V3.2 在研增量仍通过各自的工作树交接。

当前集成源码通过独立 QA 原样 B1-04。撤销后的两条 HTTP 请求中合成标记为 **0 次、0 字节**。集成测试另覆盖收到请求前后的撤权、摘要压缩、跨进程恢复、合法文档保留以及旧明文留在本地审计时的外发隔离。其请求数据只含合成夹具。[独立 B1-04](.artifacts/integration/dispatch-qa/b1.jsonl) · [同会话请求](.artifacts/integration/dispatch-wire/02-same-session.json) · [发送前撤权](.artifacts/integration/dispatch-wire/05-revoked-while-assembled.json) · [跨进程恢复](.artifacts/integration/dispatch-wire/08-cross-process-after.json)

补充离线回归覆盖 Agent Loop、AgentSession、分支和压缩摘要，以及使用 Mock 的模型适配器。Agent 38 项通过，Coding Agent 11 项通过、5 项按既有条件跳过，AI 140 项通过。改动范围内 55 个受 Biome 检查的 TypeScript 文件通过。离线构建、工作区类型、评测类型、专项类型和包泄漏检查通过。原仓库及三个开发工作树再次核对一致，保护的 42 项历史删除仍在原仓库。[Agent](.artifacts/integration/dispatch-agent-vitest.json) · [Coding Agent](.artifacts/integration/dispatch-coding-agent-vitest.json) · [AI](.artifacts/integration/dispatch-ai-vitest.json) · [来源工作树核对](.artifacts/integration/dispatch-origin-verification.json)

最终回归从包目录运行，使用上文 Docker 开关，另设 PI_KNOWLEDGE_WIRE_EVIDENCE 为集成树下 .artifacts/integration/dispatch-full-wire 的绝对路径。

    $report=Join-Path $PWD '.artifacts/integration/dispatch-full-vitest.json'
    npm run test --workspace @wz-agent/pi-enhanced -- tests/unit tests/integration tests/e2e --exclude '**/.artifacts/**' --maxWorkers=1 --testTimeout=30000 --reporter=dot --reporter=json "--outputFile=$report"
    node node_modules/vitest/dist/cli.js run --config .artifacts/integration/b1-qa-replay/vitest.config.ts -t 'B1-04' --maxWorkers=1 --reporter=verbose

三组补充测试分别从 packages/agent、packages/coding-agent 和 packages/ai 运行。命令均使用 node ../../node_modules/vitest/vitest.mjs --run，附相应文件列表与 --maxWorkers=1。

| 包 | 定向测试文件 |
| --- | --- |
| Agent | agent-loop.test.ts |
| Coding Agent | agent-session-concurrent.test.ts、agent-session-compaction.test.ts、branch-summarization.test.ts、branch-summary-extensions.test.ts |
| AI | openai-completions-retry.test.ts、openai-responses-compat.test.ts、openai-codex-stream.test.ts、azure-openai-responses-reasoning-replay.test.ts、anthropic-sse-parsing.test.ts、mistral-http-transport.test.ts、bedrock-custom-headers.test.ts、faux-provider.test.ts |

最终全量回归为 422 项通过、0 项失败、30 项按条件跳过。真实 Docker 用例包含 Qdrant、E5 和 Docling。无网 Python Memory 测试、沙箱烟测和临时资源核验通过。全仓 Biome 检查了 1647 个文件，仍有 10 条基线错误，涉及的文件均与共同基线一致。独立 Linux Docker CI 和 V3.1/V3.2 在研增量尚未合入本次验收。

最终源码快照包含 105 条路径。解压后将 files 内容覆盖到 9f44c107de607b73d4cd822455389c7e90b366cd 的干净 worktree。manifest.json 记录各路径 SHA-256，tracked.patch 提供 Git 的二进制差异。首版源码及混合版本失败日志保留作为证据。所有外发测试均使用本地 Stub，无真实模型调用。本轮未暂存、提交或推送。

[最终源码](.artifacts/integration/pi-enhanced-integration-9f44c107d-disclosure-source.zip) · [SHA-256](.artifacts/integration/pi-enhanced-integration-9f44c107d-disclosure-source.zip.sha256) · [最终全量回归](.artifacts/integration/dispatch-full-vitest.json) · [测试身份](.artifacts/integration/dispatch-test-manifest.json) · [资源核对](.artifacts/integration/dispatch-resource-verification.json)
