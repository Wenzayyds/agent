import { createInterface } from "node:readline";

const contract = process.argv[1];
const name = "get_config_contract";
const schema = { type: "object", properties: {}, additionalProperties: false };
for await (const line of createInterface({ input: process.stdin })) {
	const { id, method, params } = JSON.parse(line);
	if (id === undefined) continue;
	let result;
	let error;
	if (method === "initialize") {
		result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
	} else if (method === "tools/list") {
		result = { tools: [{ name, description: "Read the project's configuration contract.", inputSchema: schema, annotations: { readOnlyHint: true } }] };
	} else if (method === "tools/call" && params?.name === name && Object.keys(params.arguments ?? {}).length === 0) {
		result = { content: [{ type: "text", text: contract }] };
	} else if (method === "ping") {
		result = {};
	} else {
		error = { code: method === "tools/call" ? -32602 : -32601, message: "Unsupported contract request" };
	}
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }) + "\n");
}
