import { setTimeout as wait } from "node:timers/promises";
import { type Task, TaskState } from "@a2a-js/sdk";
import { type Client, ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { digest } from "../multi-local/protocol.ts";
import {
	type A2AConnection,
	a2aPath,
	artifactFromTask,
	cardPath,
	maxBody,
	messageFor,
	type RemoteTestIntent,
	uuid,
	validateConnection,
} from "./contract.ts";
import { A2ATaskStore, storedArtifact } from "./store.ts";

const terminalCodes = new Map([
	[TaskState.TASK_STATE_CANCELED, "MA2_CANCELLED"],
	[TaskState.TASK_STATE_REJECTED, "MA2_REMOTE_REJECTED"],
	[TaskState.TASK_STATE_FAILED, "MA2_REMOTE_EXECUTION_UNCERTAIN"],
]);
const pollMs = 225;

export async function executeRemoteTest(
	connection: A2AConnection,
	databasePath: string,
	intent: RemoteTestIntent,
	signal: AbortSignal,
	priorId: string | undefined,
	mapped: (id: string) => void,
	fetcher: typeof fetch = fetch,
) {
	let id = priorId;
	let client: Client | undefined;
	try {
		client = await retry(() => connect(connection, fetcher, signal), signal);
		let task: Task;
		if (!id) {
			const response = await retry(() => client!.sendMessage(messageFor(intent), { signal }), signal);
			if (!("id" in response) || !uuid.test(response.id)) throw new Error("MA2_INVALID_RESPONSE");
			task = response;
			id = task.id;
			mapped(id);
		} else {
			task = await getTask(client, id, signal);
		}
		for (let polls = 0; polls <= 1200; polls++) {
			if (task.id !== id) throw new Error("MA2_INVALID_RESPONSE");
			if (task.status?.state === TaskState.TASK_STATE_COMPLETED) {
				const store = new A2ATaskStore(databasePath, true);
				try {
					const record = store.get(connection.principalId, id);
					const trusted = record && storedArtifact(record);
					if (!trusted || record.intent_hash !== digest(intent) || digest(trusted.intent) !== digest(intent))
						throw new Error("MA2_ARTIFACT_UNVERIFIED");
					return artifactFromTask(task, trusted);
				} finally {
					store.close();
				}
			}
			const state = task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED;
			if (state !== TaskState.TASK_STATE_SUBMITTED && state !== TaskState.TASK_STATE_WORKING)
				throw new Error(terminalCodes.get(state) ?? "MA2_INVALID_RESPONSE");
			signal.throwIfAborted();
			await wait(pollMs, undefined, { signal });
			task = await getTask(client, id, signal);
		}
		throw new Error("MA2_POLL_LIMIT");
	} catch (error) {
		if (signal.aborted && client && id) {
			try {
				await client.cancelTask({ tenant: "", id, metadata: undefined }, { signal: AbortSignal.timeout(500) });
			} catch {
				/* The server's own deadline still applies. A completed task keeps its artifact. */
			}
		}
		if (signal.aborted) throw new Error("MA2_WAIT_CANCELLED");
		throw error;
	}
}

function getTask(client: Client, id: string, signal: AbortSignal): Promise<Task> {
	return retry(() => client.getTask({ tenant: "", id, historyLength: 0 }, { signal }), signal);
}

async function connect(connection: A2AConnection, fetcher: typeof fetch, signal: AbortSignal) {
	validateConnection(connection);
	const cardUrl = connection.origin + cardPath;
	const endpoint = connection.origin + a2aPath;
	const guardedFetch: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const isCard = request.method === "GET" && request.url === cardUrl;
		if (!isCard && (request.method !== "POST" || request.url !== endpoint)) throw new Error("MA2_ENDPOINT_DENIED");
		const headers = new Headers(request.headers);
		if (!isCard) headers.set("authorization", `Bearer ${connection.token}`);
		const timeout = AbortSignal.timeout(connection.timeoutMs ?? 5000);
		const requestSignal = AbortSignal.any([request.signal, timeout, ...(isCard ? [signal] : [])]);
		try {
			const response = await fetcher(request, { headers, redirect: "manual", signal: requestSignal });
			if (response.status === 502 || response.status === 503 || response.status === 504) {
				await response.body?.cancel();
				throw new Error("MA2_TRANSPORT_UNAVAILABLE");
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error("MA2_HTTP_REJECTED");
			}
			if (!response.body || !response.headers.get("content-type")?.startsWith("application/json")) {
				await response.body?.cancel();
				throw new Error("MA2_RESPONSE_INVALID");
			}
			const payload = new Uint8Array(maxBody);
			const reader = response.body.getReader();
			let count = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (count + value.byteLength > maxBody) {
					await reader.cancel();
					throw new Error("MA2_RESPONSE_LIMIT");
				}
				payload.set(value, count);
				count += value.byteLength;
			}
			return new Response(payload.subarray(0, count), { headers: { "content-type": "application/json" } });
		} catch (error) {
			if (error instanceof Error && /^MA2_/u.test(error.message)) throw error;
			throw new Error("MA2_TRANSPORT_UNAVAILABLE");
		}
	};
	const resolver = new DefaultAgentCardResolver({ fetchImpl: guardedFetch });
	const card = await resolver.resolve(connection.origin);
	if (
		card.supportedInterfaces.length !== 1 ||
		card.supportedInterfaces[0]?.url !== endpoint ||
		card.supportedInterfaces[0].protocolBinding !== "JSONRPC" ||
		card.supportedInterfaces[0].protocolVersion !== "1.0"
	)
		throw new Error("MA2_CARD_UNTRUSTED");
	return new ClientFactory({
		transports: [new JsonRpcTransportFactory({ fetchImpl: guardedFetch })],
	}).createFromAgentCard(card);
}

async function retry<T>(send: () => Promise<T>, signal: AbortSignal): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		signal.throwIfAborted();
		try {
			return await send();
		} catch (error) {
			if (attempt >= 3 || !(error instanceof Error) || error.message !== "MA2_TRANSPORT_UNAVAILABLE") throw error;
			await wait(attempt * 90, undefined, { signal });
		}
	}
}
