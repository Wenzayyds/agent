# Batch H 联合运行验证

模拟 Provider 联合 E2E 已验证：

- 模型请求只经过回环预算网关；
- Pi 的 write/read 实际进入 Docker；
- 容器无网络、根文件系统只读、非 root，仅挂载临时 `/workspace`；
- 网关或 Sandbox 不可用时失败关闭，不回退宿主工具。

H3 首次真实试跑完成了 3 次上游请求，但因旧 Runner 将工作区放在 TEMP 的同级目录，Sandbox 以 `SANDBOX_WORKSPACE_NOT_TEMPORARY` 拒绝工具执行。该问题在 Batch I 修复并重新验证。
