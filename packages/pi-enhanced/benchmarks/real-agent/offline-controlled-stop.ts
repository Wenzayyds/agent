import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installControlledStop } from "./controlled-stop.ts";
import type { OfflineDenialPolicy } from "./offline-denial-policy.ts";

/** Never loaded by default. Runner selects this entry only after validating --offline-denial-policy. */
export default function offlineControlledStop(pi: ExtensionAPI): void {
	const path = join(process.env.PI_ENHANCED_SANDBOX_RUN_ROOT!, "offline-denial-policy.json");
	installControlledStop(pi, JSON.parse(readFileSync(path, "utf8")) as OfflineDenialPolicy);
}
