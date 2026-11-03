# Batch I 网关拒绝审计

网关现记录 `requestAttempts` 和有界 `denials`，每条包含请求序号、稳定拒绝码、`upstreamForwarded` 及当时预算快照。

H3 旧产物没有逐次拒绝原因，只能保留为 `historical_reason_unknown`。

I5 实测共有 7 次尝试：3 次转发并完成，序号 4～7 的 4 次请求均以 `GATEWAY_TOKEN_BUDGET` 在本地拒绝，`upstreamForwarded=false`。拒绝后未增加 Token 或费用。
