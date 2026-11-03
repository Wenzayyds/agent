# Batch I 根因审计

旧 Runner 设置子进程 `TEMP/TMP=<runRoot>/temp`，任务工作区位于同级 `<runRoot>/<task>`。Sandbox 使用 `relative(os.tmpdir(), workspace)` 检查时得到以 `..` 开头的路径，因此抛出 `SANDBOX_WORKSPACE_NOT_TEMPORARY`。

H2 联合 E2E 自建了合规工作区，没有走生产 `run-real-agent.ts`，所以没有提前发现这一差异。

修复采用最小范围：Runner 将同一受控根同时传给 `TEMP/TMP` 与 `PI_ENHANCED_SANDBOX_RUN_ROOT`；Sandbox 要求工作区是该根的严格子目录，并绑定真实路径及设备/文件身份。没有放宽路径权限，没有宿主工具回退。
