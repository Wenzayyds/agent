import { corpus as legacyCorpus, queries as legacyQueries } from "./dataset.ts";

export type QueryType =
	| "semantic"
	| "mixed"
	| "identifier"
	| "error"
	| "similar-title"
	| "same-document"
	| "cross-section"
	| "multi-document"
	| "negative"
	| "scope"
	| "visibility";

export interface DocumentFixture {
	file: string;
	title: string;
	corpusId: string;
	sections: readonly (readonly [heading: string, text: string])[];
	visibility?: "private" | "revoked" | "deleted" | "foreign-project" | "superseded";
}

export interface QueryFixture {
	id: string;
	type: QueryType;
	text: string;
	corpusId?: string;
	onlyFile?: string;
	relevant: readonly string[];
}

export interface RetrievalDataset {
	id: string;
	documents: readonly DocumentFixture[];
	queries: readonly QueryFixture[];
}

const legacyTypes = [
	"identifier",
	"identifier",
	"identifier",
	"identifier",
	"error",
	"error",
	"mixed",
	"semantic",
	"semantic",
	"semantic",
	"semantic",
	"semantic",
	"visibility",
	"scope",
] as const;

export const legacy: RetrievalDataset = {
	id: "docs-v1",
	documents: legacyCorpus.map((document) => ({
		...document,
		visibility: "private" in document ? "private" : undefined,
	})),
	queries: legacyQueries.map((query, index) => ({ ...query, id: `legacy-${index + 1}`, type: legacyTypes[index] })),
};

function docs(
	file: string,
	title: string,
	sections: DocumentFixture["sections"],
	corpusId = "product",
	visibility?: DocumentFixture["visibility"],
): DocumentFixture {
	return { file: `${file}.md`, title, corpusId, sections, visibility };
}

function cases(
	rows: readonly (readonly [
		id: string,
		type: QueryType,
		text: string,
		labels: readonly string[],
		scope?: { corpusId?: string; onlyFile?: string },
	])[],
): QueryFixture[] {
	return rows.map(([id, type, text, relevant, scope]) => ({ id, type, text, relevant, ...scope }));
}

function background(topic: string, subjects: readonly string[]): DocumentFixture[] {
	return subjects.map((subject, index) =>
		docs(`notes-${index + 1}`, `${subject} reference notes`, [
			["Inventory", `The ${subject} team counts managed ${topic} resources in a monthly inventory spreadsheet.`],
			["Ownership", `The ${subject} service catalog records the primary team and the escalation email address.`],
			[
				"Capacity",
				`${subject} capacity is reported as a quarterly arithmetic average. Planning uses calendar weeks.`,
			],
			["Monitoring", `The ${subject} dashboard displays ${topic} component health and the previous audit time.`],
			["Access", `${subject} administrators reconcile employee directory groups with the printed access register.`],
			[
				"Lifecycle",
				`Historical ${subject} labels can remain in the archive after a planning record has been superseded.`,
			],
			[
				"Deployment checklist",
				`Review the ${subject} change ticket and announce the status at the coordination meeting.`,
			],
		]),
	);
}

export const development: RetrievalDataset = {
	id: "rag-ranking-dev-v1",
	documents: [
		docs("billing", "Billing webhooks", [
			["Signature", "Verify the sender with HMAC-SHA256 over the raw HTTP body before deserializing it."],
			["Retry", "Retries use exponential backoff with jitter. A 2xx acknowledgment ends retry delivery."],
			[
				"Deduplication",
				"Deduplicate at-least-once delivery by the immutable event_id field, not the delivery attempt.",
			],
			["Dead letter", "After eight failed deliveries, events go into the dead-letter queue for manual inspection."],
		]),
		docs("billing-preview", "Billing webhook preview", [
			[
				"Preview",
				"The simulator sends unsigned sandbox events. Preview payloads do not represent live payment events.",
			],
			["Delivery", "Preview messages are delivered only once and appear in the exercise console."],
		]),
		docs("objects", "Object import API", [
			[
				"Upload",
				"POST /v2/object-imports starts batch loading. The source_uri parameter identifies the input manifest.",
			],
			["Resume", "Provide resume_token to resume an interrupted upload from the last committed part."],
			["Limits", "A single import may contain up to ten thousand object names."],
		]),
		docs("gateway", "Edge gateway errors", [
			[
				"Upstream timeout",
				"EDGE_504 reports that the origin missed the deadline. Retry safe requests with backoff.",
			],
			["Quota", "EDGE_429 reports per-tenant request throttling. Use the Retry-After header."],
			["Origin health", "Probe results only describe the health check path, not every user-facing route."],
		]),
		docs("flush", "Journal recovery procedures", [
			["冗余日志", "磁盘镜像损坏后，节点会先从异地副本读取提交日志，再重放已同步的记录。"],
			["写入暂停", "发生日志序号冲突时，冻结写入并核对两个副本的最后提交位置。"],
			["校验", "重放完成后，对比记录计数和最新提交的校验和。"],
		]),
		docs("exports", "Report export and privacy", [
			[
				"Redaction",
				"The export service removes direct identifiers and replaces customer names with stable aliases.",
			],
			["Expiration", "Download links created by the export service expire after twenty minutes."],
			["Encryption", "The export archive is encrypted with a per-export key before it is uploaded."],
		]),
		docs("retention", "Report data retention", [
			["Cleanup", "Expired export archives are permanently purged at the next hourly sweep."],
			["Legal hold", "A legal hold prevents the retention service from purging evidence until the hold is cleared."],
		]),
		docs("registry", "Credential rotation", [
			["Dual credentials", "During rotation both signing keys are accepted for a ten-minute overlap."],
			["Cleanup", "Revoke the old signing key after the overlap and check the client error dashboard."],
		]),
		docs(
			"audit",
			"Release controls",
			[
				["Approval", "A human change reviewer must sign the production rollout ticket before traffic is switched."],
				["Rollback", "On an elevated disconnect rate, restore the last known-good upstream configuration."],
			],
			"ops",
		),
		docs(
			"preview-ops",
			"Release controls",
			[
				[
					"Approval",
					"Training rollouts are automatically approved in preview and never carry real customer traffic.",
				],
			],
			"training",
		),
		docs(
			"restricted",
			"Restricted routing",
			[["Secret", "DEV_PRIVATE_ZX93 is a synthetic restricted routing marker."]],
			"product",
			"private",
		),
		docs(
			"revoked",
			"Temporary routing",
			[["Override", "DEV_REVOKED_WA93 sets the temporary route."]],
			"product",
			"revoked",
		),
		docs(
			"removed",
			"Archived router",
			[["Override", "DEV_DELETED_QN93 was a removed routing key."]],
			"product",
			"deleted",
		),
		docs(
			"revision",
			"Route timer",
			[["Old setting", "DEV_STALE_KM93 controls the deprecated timer."]],
			"product",
			"superseded",
		),
		docs(
			"other-project",
			"Foreign router",
			[["Override", "DEV_FOREIGN_RS93 is visible only in a separate project."]],
			"product",
			"foreign-project",
		),
		...background("dispatch", [
			"Catalog",
			"Scheduler",
			"Batch",
			"Dashboard",
			"Proxy",
			"Warehouse",
			"Registry",
			"Inventory",
		]),
	],
	queries: cases([
		[
			"d01",
			"semantic",
			"How can I tell whether a payment notification really came from the provider?",
			["billing.md#Signature"],
		],
		[
			"d02",
			"semantic",
			"What happens to messages that repeatedly fail to arrive at the merchant?",
			["billing.md#Dead letter"],
		],
		[
			"d03",
			"semantic",
			"After drive failure, where does the machine obtain the log to replay?",
			["flush.md#冗余日志"],
		],
		["d04", "mixed", "断点续传时 resume_token 传哪个接口？", ["objects.md#Resume"]],
		["d05", "mixed", "webhook 重复到账，如何用 event_id 防止处理两次？", ["billing.md#Deduplication"]],
		["d06", "identifier", "POST /v2/object-imports source_uri", ["objects.md#Upload"]],
		["d07", "identifier", "resume_token", ["objects.md#Resume"]],
		["d08", "error", "EDGE_504 safe retry", ["gateway.md#Upstream timeout"]],
		["d09", "error", "EDGE_429 Retry-After", ["gateway.md#Quota"]],
		[
			"d10",
			"similar-title",
			"How are simulated billing webhook events different from real ones?",
			["billing-preview.md#Preview"],
		],
		[
			"d11",
			"same-document",
			"What happens after a failed webhook attempt and after repeated failures?",
			["billing.md#Retry", "billing.md#Dead letter"],
		],
		[
			"d12",
			"cross-section",
			"During signing key rotation, how long can both keys work, and what do we do with the old one?",
			["registry.md#Dual credentials", "registry.md#Cleanup"],
		],
		[
			"d13",
			"multi-document",
			"When does an export download link expire and when will its underlying archive be removed?",
			["exports.md#Expiration", "retention.md#Cleanup"],
		],
		["d14", "scope", "Who must sign a production rollout ticket?", ["audit.md#Approval"], { corpusId: "ops" }],
		["d15", "negative", "What phase of the moon is best for planting garlic?", []],
		["d16", "negative", "ZX_NO_MATCH_5782", []],
		["d17", "visibility", "DEV_PRIVATE_ZX93", [], { onlyFile: "restricted.md" }],
		["d18", "visibility", "DEV_REVOKED_WA93", [], { onlyFile: "revoked.md" }],
		["d19", "visibility", "DEV_DELETED_QN93", [], { onlyFile: "removed.md" }],
		["d20", "visibility", "DEV_STALE_KM93", [], { onlyFile: "revision.md" }],
		["d21", "scope", "DEV_FOREIGN_RS93", [], { onlyFile: "other-project.md" }],
	]),
};

export const validation: RetrievalDataset = {
	id: "rag-ranking-holdout-v1",
	documents: [
		docs("search-rebuild", "Search index rebuild", [
			[
				"Shadow index",
				"Build a second index alongside the serving index. Queries continue against the old snapshot during the backfill.",
			],
			["Verification", "Compare counts and run a query smoke test before moving the alias."],
			[
				"Alias switch",
				"Update the read alias in one atomic operation; retain the old index until the observation window closes.",
			],
		]),
		docs("search-repair", "Search index repair", [
			[
				"Shard recovery",
				"Restore the missing primary shard from yesterday's snapshot before rejoining the replica.",
			],
			["Checksum", "A replica must match the primary shard checksum before it can accept read traffic."],
		]),
		docs("video", "Media ingestion endpoint", [
			["Create job", "POST /v3/transcode creates an encoding job. profile_id selects the output resolution."],
			["State", "GET /v3/transcode/{job_id} returns progress and the current task phase."],
			["Callback", "Set callback_uri to receive a notification when the output has been produced."],
		]),
		docs("media-status", "Media service errors", [
			[
				"Invalid codec",
				"MEDIA_415 means the supplied container or codec is unsupported; convert the file before retrying.",
			],
			["Capacity", "MEDIA_503 means the transcoding queue is temporarily full; wait before submitting another job."],
		]),
		docs("power", "机房电源保护", [
			["短时供电", "市电中断时，由不间断电源中的蓄电池支撑网络设备，直到柴油发电机接管。"],
			["设备顺序", "电力恢复以后，先启动交换机，等网络稳定再启动存储服务器。"],
		]),
		docs("fleet", "Device enrollment", [
			[
				"Enrollment code",
				"Generate a single-use QR enrollment code in the device console. It expires after five minutes.",
			],
			["Device removal", "When removing a lost device, revoke its certificate and wipe centrally managed data."],
		]),
		docs(
			"control",
			"Active incident response",
			[
				["Command", "Run trace_path() to locate the network segment that drops packets."],
				[
					"Incident owner",
					"The on-call network engineer coordinates packet loss incidents and assigns a communications lead.",
				],
			],
			"ops",
		),
		docs(
			"control-training",
			"Active incident response",
			[
				[
					"Incident owner",
					"The instructor coordinates simulated incidents. Do not contact the production on-call engineer.",
				],
			],
			"training",
		),
		docs("keys", "Device certificate lifecycle", [
			[
				"Validity",
				"Device certificates last ninety days and are renewed automatically thirty days before expiration.",
			],
			["Recovery", "A device with an expired certificate must run enrollment again with a new enrollment code."],
		]),
		docs("mirror", "Cold artifact mirroring", [
			[
				"Consistency",
				"Validate a checksum after transferring each artifact; retry the damaged part without starting over.",
			],
			["Schedule", "An archive mirror runs only during the nightly maintenance window."],
		]),
		docs(
			"restricted",
			"Restricted responder",
			[["Secret", "VAL_PRIVATE_NY26 is a synthetic responder channel."]],
			"product",
			"private",
		),
		docs(
			"revoked",
			"Temporary responder",
			[["Override", "VAL_REVOKED_CQ26 sets the temporary responder."]],
			"product",
			"revoked",
		),
		docs(
			"removed",
			"Archived responder",
			[["Override", "VAL_DELETED_DX26 was a retired responder key."]],
			"product",
			"deleted",
		),
		docs(
			"revision",
			"Responder timer",
			[["Old setting", "VAL_STALE_GT26 controls an obsolete timer."]],
			"product",
			"superseded",
		),
		docs(
			"other-project",
			"Foreign responder",
			[["Override", "VAL_FOREIGN_KP26 is a separate project's responder."]],
			"product",
			"foreign-project",
		),
		...background("telemetry", [
			"Directory",
			"Ingress",
			"Metrics",
			"Archive",
			"Control",
			"Storage",
			"Switch",
			"Support",
		]),
	],
	queries: cases([
		[
			"v01",
			"semantic",
			"Can customers keep searching during the data copy for a fresh index?",
			["search-rebuild.md#Shadow index"],
		],
		[
			"v02",
			"semantic",
			"What powers the switches when utility power drops before the backup engine starts?",
			["power.md#短时供电"],
		],
		[
			"v03",
			"semantic",
			"A file part was damaged during transfer. How can I avoid copying the entire file again?",
			["mirror.md#Consistency"],
		],
		["v04", "mixed", "转码结束通知回调地址是 callback_uri 吗？", ["video.md#Callback"]],
		["v05", "mixed", "路径哪里丢包，如何运行 trace_path()？", ["control.md#Command"]],
		["v06", "identifier", "POST /v3/transcode profile_id", ["video.md#Create job"]],
		["v07", "identifier", "GET /v3/transcode/{job_id}", ["video.md#State"]],
		["v08", "error", "MEDIA_415 unexpected codec", ["media-status.md#Invalid codec"]],
		["v09", "error", "MEDIA_503 waiting queue", ["media-status.md#Capacity"]],
		["v10", "similar-title", "Which snapshot restores a missing primary shard?", ["search-repair.md#Shard recovery"]],
		[
			"v11",
			"same-document",
			"How do I verify the replacement search index and make it handle reads?",
			["search-rebuild.md#Verification", "search-rebuild.md#Alias switch"],
		],
		[
			"v12",
			"cross-section",
			"How do I create a transcoding job and query its current state?",
			["video.md#Create job", "video.md#State"],
		],
		[
			"v13",
			"multi-document",
			"After the device certificate expires, how do I enroll it again and how long does the QR code last?",
			["keys.md#Recovery", "fleet.md#Enrollment code"],
		],
		[
			"v14",
			"scope",
			"Who coordinates the packet loss incident and coordinates communications?",
			["control.md#Incident owner"],
			{ corpusId: "ops" },
		],
		["v15", "negative", "How do I prepare a gluten-free pie crust?", []],
		["v16", "negative", "ZZ_UNKNOWN_CODEC_9974", []],
		["v17", "visibility", "VAL_PRIVATE_NY26", [], { onlyFile: "restricted.md" }],
		["v18", "visibility", "VAL_REVOKED_CQ26", [], { onlyFile: "revoked.md" }],
		["v19", "visibility", "VAL_DELETED_DX26", [], { onlyFile: "removed.md" }],
		["v20", "visibility", "VAL_STALE_GT26", [], { onlyFile: "revision.md" }],
		["v21", "scope", "VAL_FOREIGN_KP26", [], { onlyFile: "other-project.md" }],
	]),
};

// Separate acceptance set. These fixtures are never consumed by the weight selector.
export const evidenceChallenge: RetrievalDataset = {
	id: "rag-k7-evidence-v1",
	documents: [
		docs("relay", "Relay recovery handbook", [
			["Traffic", "After a relay outage, requests resume only after a supervisor resets the relay."],
			["Recovery limit", "The backup relay handles 200 requests per minute. It cannot handle writes."],
			["Diagnostics", "Run inspect_relay() to display the current relay state."],
		]),
		docs("queues", "Queue reference", [
			["Limits", "The maximum queue depth is 1500 items. The queue_reject_limit parameter controls admission."],
			["Failure", "QUEUE_731 indicates that the consumer has not acknowledged receipt."],
		]),
		docs("replica", "异地副本手册", [
			["校验", "灾备站恢复前，必须逐文件比较校验和。校验失败时重新复制损坏的文件即可。"],
			["恢复", "只有值班员确认校验完成后才可对外恢复访问。"],
		]),
		docs("shipping", "Shipment endpoint", [
			["Create", "POST /v4/shipments uses the warehouse_code parameter."],
			["Check", "GET /v4/shipments/{shipment_id} reports the carrier dispatch stage."],
		]),
	],
	queries: cases([
		["e01", "identifier", "inspect_relay()", ["relay.md#Diagnostics"]],
		["e02", "error", "QUEUE_731", ["queues.md#Failure"]],
		["e03", "identifier", "POST /v4/shipments warehouse_code", ["shipping.md#Create"]],
		["e04", "semantic", "中继器故障后，什么时候能重新接收请求？", ["relay.md#Traffic"]],
		["e05", "semantic", "After checksum failure, do we need to copy the whole backup again?", ["replica.md#校验"]],
		["e06", "cross-section", "校验失败后要怎么重试，谁有权确认恢复外部访问？", ["replica.md#校验", "replica.md#恢复"]],
		["e07", "multi-document", "How many requests can the backup relay serve, and how many entries can the queue hold?", ["relay.md#Recovery limit", "queues.md#Limits"]],
		["e08", "negative", "What is the migration route of a monarch butterfly?", []],
		["e09", "negative", "Which supervisor can reset the relay on weekends?", []],
		["e10", "negative", "What is the power budget in watts for the backup relay at 200 requests per minute?", []],
		["e11", "negative", "warehouse_code_expired", []],
		["e12", "negative", "What retry window is mandated by QUEUE_731?", []],
	]),
};

export function documentText(document: DocumentFixture): string {
	return [`# ${document.title}`, ...document.sections.map(([heading, body]) => `## ${heading}\n\n${body}`)].join(
		"\n\n",
	);
}
