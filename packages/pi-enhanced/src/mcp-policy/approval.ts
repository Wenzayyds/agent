import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { McpToolIdentity } from "./identity.ts";

export type ApprovalResult = "approved" | "cancelled" | "unavailable" | "error";

export async function requestApproval(
	identity: McpToolIdentity,
	annotations: Readonly<Record<string, unknown>> | undefined,
	ctx: ExtensionContext,
	timeoutMs: number,
): Promise<ApprovalResult> {
	if (!ctx.hasUI) return "unavailable";
	const risk =
		annotations?.destructiveHint === true ? "高" : annotations?.readOnlyHint === true ? "低（服务端声明）" : "未知";
	try {
		const approved = await ctx.ui.confirm(
			"MCP 工具调用确认",
			`Server: ${identity.server}\n工具: ${identity.tool}\n风险: ${risk}\n\n是否允许本次调用？`,
			{ timeout: timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) },
		);
		return approved ? "approved" : "cancelled";
	} catch {
		return "error";
	}
}
