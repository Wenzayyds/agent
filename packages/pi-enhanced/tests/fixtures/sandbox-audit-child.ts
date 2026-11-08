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
	void broker.request("write", "write_file", { path: "uncertain.txt", content: "x".repeat(512 * 1024) });
});
process.send?.({ ready: true, containerId: broker.getEvidence()!.containerId });
setInterval(() => {}, 1000);
