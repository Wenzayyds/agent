import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOfficialHarness } from "./swe-evaluator.ts";

export {
	assessSwePrediction,
	harnessCommand,
	officialOutcome,
	readOfficialOutcome,
	SWE_DATA_REVISION,
	SWE_HARNESS_COMMIT,
	windowsDockerStorage,
} from "./swe-evaluator.ts";
export {
	type PublicIssue,
	publicInstance,
	SWE_EVALUATION_PROTOCOL,
	SWE_SOURCE_INSTRUCTIONS,
	swePrompt,
} from "./swe-instance.ts";
export { exportSwePrediction, safePatchPath, sweWritePathAllowed } from "./swe-patch.ts";
export { loadSweTask, prepareSweWorkspace, safeBasePath, type SweTask } from "./swe-workspace.ts";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runOfficialHarness();
