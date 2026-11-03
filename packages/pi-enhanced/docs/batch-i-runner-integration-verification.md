# Batch I 生产 Runner 验证

本地 Stub Provider 通过生产 `run-real-agent.ts` 完成：预算网关 → Pi CLI → Docker 文件工具 → 补丁 → 隐藏验证器。正确补丁 SHA-256 为 `5fa0153b3fef99b46b88d914995710c3b2d57a70be13315c2abb8bd37c50bdd0`。

缺失镜像负向测试证明 Docker 预检发生在网关启动前，Provider 收到 0 次请求。外部哨兵未变化，容器残留为 0。
