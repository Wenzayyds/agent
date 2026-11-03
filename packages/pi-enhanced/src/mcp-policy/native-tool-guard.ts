import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { NativeToolGuardConfig } from "./config.ts";

export type NativeToolRisk = "read_only" | "workspace_mutation" | "external_side_effect" | "unknown";
export type NativeToolDecision = "allowed" | "approved" | "denied" | "cancelled";

export interface NativeToolAuditRecord {
	toolCallId: string;
	parentToolCallId?: string;
	toolName: string;
	risk: NativeToolRisk;
	decision: NativeToolDecision;
	pathClass?: "workspace" | "outside" | "protected" | "invalid";
	reasonCode: string;
	at: number;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const MUTATION_TOOLS = new Set(["write", "edit"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

export class NativeToolGuard {
	readonly config: NativeToolGuardConfig;
	private records: NativeToolAuditRecord[] = [];

	constructor(config: NativeToolGuardConfig) {
		this.config = config;
	}

	async evaluate(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		if (!this.config.enabled || event.toolName.startsWith("mcp__")) return undefined;
		if (READ_TOOLS.has(event.toolName)) return this.handleRead(event, ctx);
		if (MUTATION_TOOLS.has(event.toolName)) return this.handleMutation(event, ctx);
		if (SHELL_TOOLS.has(event.toolName)) return this.handleShell(event, ctx);
		return undefined;
	}

	snapshot(): readonly NativeToolAuditRecord[] {
		return this.records.map((record) => ({ ...record }));
	}

	clear(): void {
		this.records = [];
	}

	private handleRead(event: ToolCallEvent, ctx: ExtensionContext): ToolCallEventResult | undefined {
		const path = pathInput(event) ?? ".";
		const classification = classifyPath(ctx.cwd, path, false, this.config.protectProjectMetadata);
		if (classification.pathClass !== "workspace") {
			return this.deny(event, "read_only", classification.pathClass, classification.reasonCode);
		}
		this.record(event, "read_only", "allowed", "workspace", "workspace-read");
		return undefined;
	}

	private async handleMutation(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		if (!ctx.isProjectTrusted()) return this.deny(event, "workspace_mutation", "invalid", "project-untrusted");
		const path = pathInput(event);
		if (!path) return this.deny(event, "workspace_mutation", "invalid", "path-missing");
		const classification = classifyPath(ctx.cwd, path, true, this.config.protectProjectMetadata);
		if (classification.pathClass !== "workspace") {
			return this.deny(event, "workspace_mutation", classification.pathClass, classification.reasonCode);
		}
		if (this.config.workspaceMutationAction === "allow") {
			this.record(event, "workspace_mutation", "allowed", "workspace", "user-configured-workspace-only");
			return undefined;
		}
		const approved = await this.confirm(
			ctx,
			"原生文件修改确认",
			`工具: ${event.toolName}\n范围: 当前工作区\n路径: ${safeDisplayPath(ctx.cwd, path)}\n\n是否允许本次修改？`,
		);
		if (!approved)
			return this.deny(
				event,
				"workspace_mutation",
				"workspace",
				ctx.hasUI ? "approval-cancelled" : "approval-unavailable",
				ctx.hasUI ? "cancelled" : "denied",
			);
		this.record(event, "workspace_mutation", "approved", "workspace", "user-approved");
		return undefined;
	}

	private async handleShell(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		if (!ctx.isProjectTrusted()) return this.deny(event, "unknown", undefined, "project-untrusted");
		const approved = await this.confirm(
			ctx,
			"原生 Shell 调用确认",
			`工具: ${event.toolName}\n风险: 无法可靠解析完整 Shell 语义，按高风险处理。\n命令摘要: ${shellSummary(event)}\n\n是否允许本次调用？`,
		);
		if (!approved)
			return this.deny(
				event,
				"unknown",
				undefined,
				ctx.hasUI ? "approval-cancelled" : "approval-unavailable",
				ctx.hasUI ? "cancelled" : "denied",
			);
		this.record(event, "unknown", "approved", undefined, "user-approved-shell");
		return undefined;
	}

	private async confirm(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
		if (!ctx.hasUI) return false;
		try {
			return await ctx.ui.confirm(title, message, {
				timeout: this.config.approvalTimeoutMs,
				...(ctx.signal ? { signal: ctx.signal } : {}),
			});
		} catch {
			return false;
		}
	}

	private deny(
		event: ToolCallEvent,
		risk: NativeToolRisk,
		pathClass: NativeToolAuditRecord["pathClass"] | undefined,
		reasonCode: string,
		decision: NativeToolDecision = "denied",
	): ToolCallEventResult {
		this.record(event, risk, decision, pathClass, reasonCode);
		return { block: true, reason: `Native tool guard blocked ${event.toolName}: ${reasonCode}` };
	}

	private record(
		event: ToolCallEvent,
		risk: NativeToolRisk,
		decision: NativeToolDecision,
		pathClass: NativeToolAuditRecord["pathClass"] | undefined,
		reasonCode: string,
	): void {
		this.records.push({
			toolCallId: event.toolCallId,
			...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
			toolName: event.toolName,
			risk,
			decision,
			...(pathClass ? { pathClass } : {}),
			reasonCode,
			at: Date.now(),
		});
		if (this.records.length > this.config.maxRecent)
			this.records.splice(0, this.records.length - this.config.maxRecent);
	}
}

function pathInput(event: ToolCallEvent): string | undefined {
	const value = (event.input as Record<string, unknown>).path;
	return typeof value === "string" && value.trim() ? value : undefined;
}

function classifyPath(
	rootInput: string,
	pathInput: string,
	allowMissingLeaf: boolean,
	protectProjectMetadata: boolean,
): { pathClass: NativeToolAuditRecord["pathClass"]; reasonCode: string } {
	try {
		const root = realpathSync.native(rootInput);
		const requested = resolve(root, pathInput);
		const resolved = resolveExistingPath(requested, allowMissingLeaf);
		if (!inside(root, resolved)) return { pathClass: "outside", reasonCode: "path-outside-workspace" };
		const relativePath = relative(root, requested).replaceAll("\\", "/");
		if (
			protectProjectMetadata &&
			(relativePath === ".git" ||
				relativePath.startsWith(".git/") ||
				relativePath === ".pi" ||
				relativePath.startsWith(".pi/"))
		)
			return { pathClass: "protected", reasonCode: "protected-project-metadata" };
		return { pathClass: "workspace", reasonCode: "workspace-path" };
	} catch {
		return { pathClass: "invalid", reasonCode: "path-resolution-failed" };
	}
}

function resolveExistingPath(requested: string, allowMissingLeaf: boolean): string {
	if (existsSync(requested)) return realpathSync.native(requested);
	if (!allowMissingLeaf) throw new Error("path does not exist");
	let cursor = dirname(requested);
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) throw new Error("no existing ancestor");
		cursor = parent;
	}
	const realParent = realpathSync.native(cursor);
	return resolve(realParent, relative(cursor, requested));
}

function inside(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function safeDisplayPath(root: string, input: string): string {
	const value = relative(root, resolve(root, input)).replaceAll("\\", "/");
	return value && !value.startsWith("..") ? value.slice(0, 300) : "[outside-workspace]";
}

function shellSummary(event: ToolCallEvent): string {
	const command = (event.input as Record<string, unknown>).command;
	if (typeof command !== "string") return "[invalid-command]";
	return `${command.trim().replace(/\s+/gu, " ").slice(0, 120)}${command.length > 120 ? "…" : ""}`;
}
