import { Agent, request } from "node:http";

const loopbackAgent = new Agent({ keepAlive: true, maxSockets: 16 });
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const QDRANT_BATCH_LIMIT = 128;

type Scalar = string | boolean | number;
export type VectorCondition =
	| {
			key: string;
			match: { value: Scalar } | { any: readonly (string | number)[] } | { except: readonly (string | number)[] };
	  }
	| { key: string; range: { lt?: number; lte?: number; gt?: number; gte?: number } }
	| { is_empty: { key: string } }
	| { has_id: readonly string[] }
	| VectorFilter;
export interface VectorFilter {
	must?: readonly VectorCondition[];
	should?: readonly VectorCondition[];
	must_not?: readonly VectorCondition[];
}
export interface IndexedPoint<P extends object> {
	id: string;
	payload: P;
}
export interface VectorWrite<P extends object> extends IndexedPoint<P> {
	vector: readonly number[];
}
export interface VectorIndex<P extends object> {
	ensure(): Promise<void>;
	upsert(points: readonly VectorWrite<P>[]): Promise<void>;
	delete(ids: readonly string[]): Promise<void>;
	search(
		vector: readonly number[],
		options: { limit: number; filter?: VectorFilter },
	): Promise<(IndexedPoint<P> & { score: number })[]>;
	scroll(options?: {
		limit?: number;
		cursor?: string;
		filter?: VectorFilter;
	}): Promise<{ points: IndexedPoint<P>[]; cursor?: string }>;
	get(ids: readonly string[]): Promise<IndexedPoint<P>[]>;
}

export type QdrantErrorCode =
	| "qdrant-unavailable"
	| "qdrant-timeout"
	| "qdrant-rate-limited"
	| "qdrant-permission-denied"
	| "qdrant-request-failed"
	| "qdrant-invalid-response"
	| "qdrant-incompatible-collection";
export class QdrantError extends Error {
	readonly code: QdrantErrorCode;
	readonly httpStatus?: number;

	constructor(code: QdrantErrorCode, httpStatus?: number) {
		super(httpStatus ? `${code} (HTTP ${httpStatus})` : code);
		this.name = "QdrantError";
		this.code = code;
		this.httpStatus = httpStatus;
	}
}

export interface QdrantIndexOptions<P extends object> {
	endpoint: string;
	collectionName: string;
	dimensions: number;
	timeoutMs?: number;
	payloadIndexes?: Readonly<Record<string, "keyword" | "integer" | "bool" | "float">>;
	parsePayload: (value: unknown) => P;
}

export class QdrantIndex<P extends object> implements VectorIndex<P> {
	private readonly endpoint: string;
	private readonly path: string;
	private readonly dimensions: number;
	private readonly timeoutMs: number;
	private readonly parsePayload: (value: unknown) => P;
	private readonly payloadIndexes: NonNullable<QdrantIndexOptions<P>["payloadIndexes"]>;

	constructor(options: QdrantIndexOptions<P>) {
		const url = new URL(options.endpoint);
		if (
			url.protocol !== "http:" ||
			!["127.0.0.1", "[::1]"].includes(url.hostname) ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			throw new TypeError("Qdrant endpoint must be a loopback HTTP origin");
		if (!/^[a-z][a-z0-9_]{0,62}$/u.test(options.collectionName))
			throw new TypeError("Invalid Qdrant collection name");
		this.endpoint = url.origin;
		this.path = `/collections/${options.collectionName}`;
		this.dimensions = checkedInteger(options.dimensions, 4096, "embedding dimensions");
		this.timeoutMs = checkedInteger(options.timeoutMs ?? 2_000, 30_000, "Qdrant timeout");
		this.parsePayload = options.parsePayload;
		this.payloadIndexes = { ...options.payloadIndexes };
	}

	async ensure(): Promise<void> {
		let collection: unknown;
		try {
			collection = await this.send("GET", this.path);
		} catch (error) {
			if (!(error instanceof QdrantError) || error.httpStatus !== 404) throw error;
			try {
				await this.send("PUT", this.path, { vectors: { size: this.dimensions, distance: "Cosine" } });
			} catch (error) {
				if (!(error instanceof QdrantError) || ![400, 409].includes(error.httpStatus ?? 0)) throw error;
			}
			collection = await this.send("GET", this.path);
		}
		const vectors = record(record(record(record(collection).config).params).vectors);
		if (vectors.size !== this.dimensions || vectors.distance !== "Cosine")
			throw new QdrantError("qdrant-incompatible-collection");
		const schema = record(record(collection).payload_schema);
		for (const [key, type] of Object.entries(this.payloadIndexes)) {
			const existing = record(schema[key]).data_type;
			if (existing === type) continue;
			if (existing !== undefined) throw new QdrantError("qdrant-incompatible-collection");
			await this.write("PUT", `${this.path}/index?wait=true`, { field_name: key, field_schema: type });
		}
	}

	async upsert(points: readonly VectorWrite<P>[]): Promise<void> {
		batchLimit(points);
		if (!points.length) return;
		const writes = points.map((point) => {
			this.checkVector(point.vector);
			return { id: pointId(point.id), payload: point.payload, vector: point.vector };
		});
		await this.write("PUT", `${this.path}/points?wait=true&ordering=strong`, { points: writes });
	}

	async delete(ids: readonly string[]): Promise<void> {
		batchLimit(ids);
		if (ids.length)
			await this.write("POST", `${this.path}/points/delete?wait=true&ordering=strong`, { points: ids.map(pointId) });
	}

	async search(vector: readonly number[], options: { limit: number; filter?: VectorFilter }) {
		this.checkVector(vector);
		const limit = checkedInteger(options.limit, QDRANT_BATCH_LIMIT, "Qdrant limit");
		const result = record(
			await this.send("POST", `${this.path}/points/query`, {
				query: vector,
				limit,
				filter: options.filter,
				with_payload: true,
				with_vector: false,
			}),
		);
		return responseArray(result.points, limit).map((value) => {
			const score = record(value).score;
			if (typeof score !== "number" || !Number.isFinite(score)) throw new QdrantError("qdrant-invalid-response");
			return { ...this.parsePoint(value), score };
		});
	}

	async scroll(options: { limit?: number; cursor?: string; filter?: VectorFilter } = {}) {
		const limit = checkedInteger(options.limit ?? 64, QDRANT_BATCH_LIMIT, "Qdrant limit");
		const result = record(
			await this.send("POST", `${this.path}/points/scroll`, {
				limit,
				filter: options.filter,
				offset: options.cursor && pointId(options.cursor),
				with_payload: true,
				with_vector: false,
			}),
		);
		const cursor = result.next_page_offset;
		if (cursor != null && (!isPointId(cursor) || cursor === options.cursor))
			throw new QdrantError("qdrant-invalid-response");
		return {
			points: responseArray(result.points, limit).map((value) => this.parsePoint(value)),
			cursor: cursor ?? undefined,
		};
	}

	async get(ids: readonly string[]): Promise<IndexedPoint<P>[]> {
		batchLimit(ids);
		if (!ids.length) return [];
		const requested = new Set(ids.map(pointId));
		const result = await this.send("POST", `${this.path}/points`, {
			ids: [...requested],
			with_payload: true,
			with_vector: false,
		});
		return responseArray(result, requested.size).map((value) => {
			const point = this.parsePoint(value);
			if (!requested.has(point.id)) throw new QdrantError("qdrant-invalid-response");
			return point;
		});
	}

	private parsePoint(value: unknown): IndexedPoint<P> {
		const { id, payload } = record(value);
		if (!isPointId(id)) throw new QdrantError("qdrant-invalid-response");
		try {
			return { id, payload: this.parsePayload(payload) };
		} catch {
			throw new QdrantError("qdrant-invalid-response");
		}
	}

	private checkVector(vector: readonly number[]): void {
		if (vector.length !== this.dimensions || !vector.every(Number.isFinite) || !vector.some((value) => value !== 0))
			throw new TypeError("Invalid embedding vector");
	}

	private async write(method: string, path: string, body: object): Promise<void> {
		const result = record(await this.send(method, path, body));
		if (result.status !== "completed") throw new QdrantError("qdrant-invalid-response");
	}

	private send(method: string, path: string, body?: object): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const json = body ? JSON.stringify(body) : undefined;
			const bytes = json ? Buffer.byteLength(json) : 0;
			if (bytes > MAX_REQUEST_BYTES) throw new TypeError("Qdrant request exceeds the size limit");
			const signal = AbortSignal.timeout(this.timeoutMs);
			const transportError = () => new QdrantError(signal.aborted ? "qdrant-timeout" : "qdrant-unavailable");
			const req = request(
				this.endpoint + path,
				{
					method,
					agent: loopbackAgent,
					signal,
					headers: json ? { "content-type": "application/json", "content-length": bytes } : {},
				},
				(response) => {
					const status = response.statusCode ?? 500;
					if (status < 200 || status >= 300) {
						response.destroy();
						reject(
							new QdrantError(
								status === 401 || status === 403
									? "qdrant-permission-denied"
									: status === 429
										? "qdrant-rate-limited"
										: status >= 500
											? "qdrant-unavailable"
											: "qdrant-request-failed",
								status,
							),
						);
						return;
					}
					let size = 0;
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => {
						size += chunk.length;
						if (size > MAX_RESPONSE_BYTES) {
							reject(new QdrantError("qdrant-invalid-response"));
							response.destroy();
						} else chunks.push(chunk);
					});
					response.once("error", () => reject(transportError()));
					response.once("end", () => {
						try {
							const frame = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
							if (frame.status !== "ok" || !("result" in frame))
								throw new QdrantError("qdrant-invalid-response");
							resolve(frame.result);
						} catch {
							reject(new QdrantError("qdrant-invalid-response"));
						}
					});
				},
			);
			req.once("error", () => reject(transportError()));
			req.end(json);
		});
	}
}

function checkedInteger(value: number, max: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`Invalid ${label}`);
	return value;
}

function batchLimit(value: readonly unknown[]): void {
	if (value.length > QDRANT_BATCH_LIMIT) throw new TypeError("Qdrant batch exceeds 128 points");
}

function isPointId(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value);
}

function pointId(value: string): string {
	if (!isPointId(value)) throw new TypeError("Qdrant point ID must be a lowercase UUID");
	return value;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function responseArray(value: unknown, limit: number): unknown[] {
	if (!Array.isArray(value) || value.length > limit) throw new QdrantError("qdrant-invalid-response");
	return value;
}
