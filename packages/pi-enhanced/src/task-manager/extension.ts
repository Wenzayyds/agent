import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerModuleExtension } from "../shared/module-extension.ts";

export default function taskManagerExtension(pi: ExtensionAPI): void {
	registerModuleExtension(pi, "task-manager");
}
