import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SANDBOX_ALLOWED_TOOLS } from "../../src/sandbox/protocol.ts";
import { registerInputAudit } from "./input-audit.ts";
import { sweWritePathAllowed } from "./swe-patch.ts";

export default function sweTools(pi: ExtensionAPI): void {
	registerInputAudit(pi, SANDBOX_ALLOWED_TOOLS);
	pi.on("tool_call", (event, ctx) => {
		if (
			["write", "edit"].includes(event.toolName) &&
			!sweWritePathAllowed(ctx.cwd, (event.input as { path?: unknown }).path)
		)
			return {
				block: true,
				reason:
					"Sandbox pilot only permits source-only writes: SWE_WRITE_PATH_DENIED. Test files may be read but must not be modified.",
			};
	});
}
