export const DATASET_VERSION = "docs-v1";

export const corpus = [
	{ file: "api.md", corpusId: "development", title: "Keys API", sections: [
		["Create key", "POST /v1/keys accepts scope_id and expires_at. Both parameters are required."],
		["Read key", "GET /v1/keys/{key_id} retrieves metadata without revealing the secret field."],
	] },
	{ file: "config.md", corpusId: "development", title: "Application configuration", sections: [
		["Storage", "Set storage.s3_region to the AWS region used by the object storage bucket."],
		["Worker", "The worker_idle_timeout_ms setting controls when an inactive worker exits."],
	] },
	{ file: "architecture.md", corpusId: "development", title: "系统架构", sections: [
		["数据持久化", "主库发生故障时，读请求可转到异步复制的只读实例。写请求必须等待主库恢复。"],
		["缓存", "更新数据库事务后删除缓存键，避免向调用方返回过期记录。"],
	] },
	{ file: "errors.md", corpusId: "development", title: "Error codes", sections: [
		["Authorization", "| Code | Meaning | Remedy |\n|---|---|---|\n| AUTH_403 | Principal lacks the requested scope | Request an approved scope |"],
		["Capacity", "LIMIT_429 means the service is throttling. Honor the Retry-After header before retrying."],
	] },
	{ file: "runbook.md", corpusId: "operations", title: "排障手册", sections: [
		["发布失败", "如果上线后一段时间仍没有健康实例，暂停流量切换，再恢复上一版本镜像。"],
		["排查锁等待", "运行 inspect_locks() 找出阻塞事务，取得数据库管理员授权后再终止连接。"],
	] },
	{ file: "release.md", corpusId: "operations", title: "Release policy", sections: [
		["审批", "生产环境部署需要发布经理人工审批。没有审批记录时，不执行生产发布。"],
		["Monitoring", "After deployment, verify the service health endpoint and watch the error budget dashboard."],
	] },
	{ file: "api-drafts.md", corpusId: "archive", title: "API drafts", sections: [
		["Creation draft", "The obsolete draft used POST /v0/tokens and a workspace parameter."],
		["Storage draft", "Region overrides in older releases came from another environment variable."],
	] },
	{ file: "private.md", corpusId: "operations", title: "Restricted internal configuration", private: true, sections: [
		["审批", "SECRET_APPROVAL_TOKEN authenticates the production rollout service."],
	] },
] as const;

interface QueryCase {
	text: string;
	corpusId?: string;
	onlyFile?: string;
	relevant: readonly string[];
}

export const queries: readonly QueryCase[] = [
	{ text: "POST /v1/keys scope_id", corpusId: "development", relevant: ["api.md#Create key"] },
	{ text: "GET /v1/keys/{key_id}", corpusId: "development", relevant: ["api.md#Read key"] },
	{ text: "storage.s3_region", relevant: ["config.md#Storage"] },
	{ text: "worker_idle_timeout_ms", relevant: ["config.md#Worker"] },
	{ text: "AUTH_403", relevant: ["errors.md#Authorization"] },
	{ text: "LIMIT_429 Retry-After", relevant: ["errors.md#Capacity"] },
	{ text: "执行 inspect_locks() 查找阻塞事务", relevant: ["runbook.md#排查锁等待"] },
	{ text: "缓存过期记录怎么处理", relevant: ["architecture.md#缓存"] },
	{ text: "Can reads continue if the primary database goes down?", relevant: ["architecture.md#数据持久化"] },
	{ text: "Who has to approve a deployment to production?", corpusId: "operations", relevant: ["release.md#审批"] },
	{ text: "How to roll back when no healthy instances come up?", corpusId: "operations", relevant: ["runbook.md#发布失败"] },
	{ text: "health and error budget after deployment", relevant: ["release.md#Monitoring"] },
	{ text: "SECRET_APPROVAL_TOKEN", onlyFile: "private.md", relevant: [] },
	{ text: "scope_id", corpusId: "unknown", relevant: [] },
];
