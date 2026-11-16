import { join } from "node:path";
import { DockerSandboxBroker } from "../../src/sandbox/broker.ts";
import { sandboxConfigForTesting } from "./runner-support.ts";

const root = process.argv[2]!;
const broker = new DockerSandboxBroker(
	sandboxConfigForTesting({
		workspace: join(root, "project"),
		runId: "batch-j-crash",
		auditReportPath: join(root, "audit.json"),
	}),
);
await broker.request("read", "read_file", { path: "fixture.txt" });
process.on("message", () => {
	// Hold the real worker response before request() can commit the operation result.
	const instance = broker as unknown as { executeWorker: (...args: unknown[]) => Promise<unknown> };
	const execute = instance.executeWorker.bind(broker);
	instance.executeWorker = async (...args) => {
		await execute(...args);
		process.send?.({ completedWorkerWrite: true });
		return new Promise<never>(() => {});
	};
	void broker.request("write", "write_file", { path: "uncertain.txt", content: "durable write before audit completion" });
});
process.send?.({ ready: true, containerId: broker.getEvidence()!.containerId });
setInterval(() => {}, 1000);
