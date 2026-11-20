import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BatchLAuthorization } from "./batch-l-authorization.ts";
import { installControlledStop } from "./controlled-stop.ts";

/** Runner selects this entry only after validating the per-batch host authorization. */
export default function batchLControlledStop(pi: ExtensionAPI): void {
	const grant = JSON.parse(
		readFileSync(join(process.env.PI_ENHANCED_SANDBOX_RUN_ROOT!, "batch-l-authorization.json"), "utf8"),
	) as BatchLAuthorization;
	installControlledStop(
		pi,
		grant.recovery === "readonly_denials_max2"
			? { schemaVersion: 1, mode: "recover_readonly_denials", maxDenials: 2 }
			: undefined,
	);
}
