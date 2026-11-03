import { existsSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextDiagnostics, ContextModuleConfig } from "../../src/context/contracts.ts";
import { createContextExtension } from "../../src/context/extension.ts";

export default function contextProbe(pi: ExtensionAPI): void {
	const path = process.env.PI_ENHANCED_CONTEXT_REPORT_PATH;
	const root = process.env.PI_ENHANCED_SANDBOX_RUN_ROOT;
	if (!path || !root || !isAbsolute(path) || relative(realpathSync(root), realpathSync(dirname(path))) !== "") {
		throw new Error("EVAL_CONTEXT_REPORT_PATH_INVALID");
	}
	const diagnostics: Readonly<ContextDiagnostics>[] = [];
	createContextExtension({ onDiagnostics(value, config: Readonly<ContextModuleConfig>) {
		if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("EVAL_CONTEXT_REPORT_PATH_INVALID");
		diagnostics.push(value);
		if (diagnostics.length > 128) diagnostics.shift();
		writeFileSync(path, JSON.stringify({ schemaVersion: 1, config, diagnostics }));
	} })(pi);
}
