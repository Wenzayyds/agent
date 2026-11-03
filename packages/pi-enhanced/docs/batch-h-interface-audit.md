# Batch H API 调用链核对

- DeepSeek 请求由 Pi 内置 `deepseekProvider` 通过 OpenAI Completions 兼容适配器发出。
- Runner 通过临时 `models.json` 将 Provider 的 `baseUrl` 固定为 `127.0.0.1` 本地预算网关。
- 真实 API Key 只保留在网关进程；Pi 子进程只收到一次性网关令牌。
- Pi 子进程显式移除 DeepSeek、OpenAI、Anthropic Key，并启用 `PI_OFFLINE=1`。
- 文件工具固定为 `read/grep/find/ls/write/edit`；Shell、MCP、Skills 和 Context files 在命令行关闭。

结论：模型请求与文件工具分别受本地预算网关和 Docker Sandbox 约束，没有修改 Pi Core。
