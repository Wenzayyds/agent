import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export const ENHANCED_CONFIG_FILE = "pi-enhanced.json";

export function getEnhancedConfigPaths(options: { agentDir: string; cwd: string; projectTrusted: boolean }): {
	global: string;
	project?: string;
} {
	return {
		global: join(options.agentDir, ENHANCED_CONFIG_FILE),
		...(options.projectTrusted ? { project: join(options.cwd, CONFIG_DIR_NAME, ENHANCED_CONFIG_FILE) } : {}),
	};
}
