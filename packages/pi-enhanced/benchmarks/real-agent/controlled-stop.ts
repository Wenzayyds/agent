import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Awaited by Pi before the next model turn; this capability can only close the gateway. */
export default function controlledStop(pi: ExtensionAPI): void {
	const url = process.env.PI_ENHANCED_CONTROLLED_GATEWAY_URL;
	const token = process.env.PI_ENHANCED_GATEWAY_TOKEN;
	if (!url || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(url) || !token) throw new Error("CONTROLLED_STOP_CHANNEL_INVALID");
	pi.on("tool_execution_end", async (event) => {
		if (!event.isError || !/SANDBOX_|Native tool guard blocked/u.test(JSON.stringify(event.result))) return;
		try {
			const response = await fetch(`${url}/__budget/stop-isolation`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000) });
			if (!response.ok) process.exit(74);
		} catch { process.exit(74); }
	});
}
