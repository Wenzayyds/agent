import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export interface McpToolIdentity {
	fullToolName: string;
	server: string;
	tool: string;
}

/** Pi uses underscores in the model-facing MCP namespace for dashes and other separators. */
export function normalizeMcpNamePart(value: string): string {
	return value.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Resolve an MCP tool from Pi's registered tool metadata, with a conservative name-only fallback. */
export function parseMcpToolIdentity(fullToolName: string, toolInfo?: ToolInfo): McpToolIdentity | undefined {
	if (!fullToolName.startsWith("mcp__")) return undefined;
	const namespace = toolInfo?.namespace;
	if (namespace?.name.startsWith("mcp__") && fullToolName.startsWith(`${namespace.name}__`)) {
		const tool = fullToolName.slice(namespace.name.length + 2);
		const server = namespace.aliases?.[0] ?? namespace.name.slice("mcp__".length);
		if (server && tool) return { fullToolName, server, tool };
	}

	const match = /^mcp__(.+?)__(.+)$/.exec(fullToolName);
	if (!match?.[1] || !match[2]) return undefined;
	return { fullToolName, server: match[1], tool: match[2] };
}
