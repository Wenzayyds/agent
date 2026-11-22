import { type MultiLocalOptions, runMultiLocal } from "../../src/multi-local/coordinator.ts";
import type { MultiLocalRequest } from "../../src/multi-local/protocol.ts";

const [json, input, checkpoint] = process.argv.slice(2);
if (json === "a2a-server") {
	const { startA2ATestServer } = await import("../../src/multi-a2a/server.ts");
	const server = await startA2ATestServer(JSON.parse(input!));
	process.send?.({ origin: server.origin, pid: process.pid });
	process.once("message", async () => {
		await server.close();
		process.disconnect?.();
	});
	process.once("disconnect", () => { void server.close(); });
} else {
	const options = JSON.parse(json!) as MultiLocalOptions;
	const request = JSON.parse(input!) as MultiLocalRequest | { resume: string };
	try {
		const result = await runMultiLocal({
			...options,
			onCheckpoint: (name, taskId) => {
				if (checkpoint === name) {
					process.send?.({ checkpoint: name, taskId, pid: process.pid }, () => process.exit(79));
					process.exit(79);
				}
			},
		}, request);
		process.send?.({ result, pid: process.pid });
	} catch (error) {
		process.send?.({ error: error instanceof Error ? error.message : "unknown", pid: process.pid });
	} finally {
		process.disconnect?.();
	}
}
