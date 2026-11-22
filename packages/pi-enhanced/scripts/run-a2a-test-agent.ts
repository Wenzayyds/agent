import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { startA2ATestServer } from "../src/multi-a2a/server.ts";
import { loadSandboxConfig } from "../src/sandbox/config.ts";
import { isPytestConfig } from "../src/sandbox/pytest.ts";

try {
	const pytest: unknown = JSON.parse(process.env.PI_ENHANCED_PYTEST_CONFIG_JSON ?? "null");
	if (!isPytestConfig(pytest)) throw new Error("MA2_SERVER_CONFIG_INVALID");
	const server = await startA2ATestServer({
		port: Number(process.env.PI_ENHANCED_A2A_PORT ?? "8765"),
		principalId: process.env.PI_ENHANCED_A2A_PRINCIPAL ?? "",
		token: process.env.PI_ENHANCED_A2A_TOKEN ?? "",
		agentDir: getAgentDir(),
		sandbox: loadSandboxConfig(),
		pytest,
	});
	process.stdout.write(JSON.stringify({ origin: server.origin, role: "test", pid: process.pid }) + "\n");
	for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { void server.close(); });
} catch (error) {
	const code = error instanceof Error && /^MA2_[A-Z0-9_]+$/u.test(error.message)
		? error.message : "MA2_SERVER_START_FAILED";
	process.stderr.write(code + "\n");
	process.exitCode = 1;
}
