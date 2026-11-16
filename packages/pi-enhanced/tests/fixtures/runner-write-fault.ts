import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Crash the actual Pi subprocess after the sandbox returns a committed edit, before tool result persistence. */
export default function interruptWrite(pi: ExtensionAPI): void {
	pi.on("tool_result", (event) => {
		if (event.toolName !== "edit" || event.isError) return;
		writeFileSync(join(process.env.PI_ENHANCED_SANDBOX_RUN_ROOT!, "fault-proof.json"),
			JSON.stringify({ toolCallId: event.toolCallId, pid: process.pid }), { flag: "wx" });
		process.kill(process.pid, "SIGKILL");
	});
}
