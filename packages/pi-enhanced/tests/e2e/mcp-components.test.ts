import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const external = process.env.PI_ENHANCED_RUN_EXTERNAL_MCP === "1" ? describe : describe.skip;
const serenaDocker = process.env.PI_ENHANCED_RUN_SERENA_DOCKER === "1" ? describe : describe.skip;
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const serenaImage =
	"ghcr.io/oraios/serena@sha256:eb52535ff1c292add25c2b2d37b2db4e2e20c60cda7d8e25f9d11490ce0e1bdf";

external("locked external MCP components", () => {
	it(
		"negotiates with @upstash/context7-mcp@4.4.4 and reaches its query endpoint",
		async () => {
			const client = new McpClient({ name: "pi-enhanced-p1-compat", version: "0.1.0" });
			const transport = new StdioTransport({
				command: process.platform === "win32" ? "npx.cmd" : "npx",
				args: ["-y", "@upstash/context7-mcp@4.4.4"],
				env: process.env.CONTEXT7_API_KEY ? { CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY } : undefined,
			});
			try {
				const initialized = await client.connect(transport);
				expect(initialized.protocolVersion).toBe(client.protocolVersion);
				const tools = await client.listTools({ timeoutMs: 60_000 });
				expect(tools.map((tool) => tool.name).sort()).toEqual(["query-docs", "resolve-library-id"]);
				const result = await client.callTool(
					"resolve-library-id",
					{ libraryName: "TypeScript", query: "compiler options documentation" },
					{ timeoutMs: 60_000 },
				);
				const text = result.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n");
				if (process.env.CONTEXT7_API_KEY) {
					expect(result.isError, JSON.stringify(result)).not.toBe(true);
					expect(text.length).toBeGreaterThan(0);
					const docs = await client.callTool(
						"query-docs",
						{ libraryId: "/vercel/next.js", query: "proxy authentication cookies" },
						{ timeoutMs: 60_000 },
					);
					const docsText = docs.content
						.filter((item) => item.type === "text")
						.map((item) => item.text)
						.join("\n");
					expect(docs.isError, JSON.stringify(docs)).not.toBe(true);
					expect(docsText.length).toBeGreaterThan(0);
				} else {
					expect(
						result.isError !== true || text.includes("Monthly quota exceeded"),
						JSON.stringify(result),
					).toBe(true);
				}
			} finally {
				await client.close();
			}
		},
		120_000,
	);
});

serenaDocker("Serena 2.1.0 official Docker image", () => {
	it(
		"finds a real symbol and its references through stdio MCP",
		async () => {
			const fixture = resolve(packageDir, "fixtures/serena-project");
			const client = new McpClient({ name: "pi-enhanced-p1-serena", version: "0.1.0" });
			const transport = new StdioTransport({
				command: "docker",
				args: [
					"run",
					"--rm",
					"-i",
					"--mount",
					`type=bind,source=${fixture},target=/workspaces/project,readonly`,
					"--tmpfs",
					"/workspaces/project/.serena/cache:rw",
					serenaImage,
					"serena",
					"start-mcp-server",
					"--transport=stdio",
					"--context=codex",
					"--agent-interface=tools",
					"--project=/workspaces/project",
					"--enable-web-dashboard=false",
					"--open-web-dashboard=false",
				],
				maxStderrBytes: 1024 * 1024,
				closeTimeoutMs: 10_000,
			});
			try {
				const initialized = await client.connect(transport);
				expect(initialized.protocolVersion).toBe(client.protocolVersion);
				const tools = await client.listTools({ timeoutMs: 120_000 });
				expect(tools.map((tool) => tool.name)).toEqual(
					expect.arrayContaining(["find_referencing_symbols", "find_symbol"]),
				);

				const found = await client.callTool(
					"find_symbol",
					{ name_path_pattern: "SymbolTarget", relative_path: "src/catalog.py", include_body: true },
					{ timeoutMs: 120_000 },
				);
				const foundText = found.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n");
				expect(found.isError, `${JSON.stringify(found)}\n${transport.stderr}`).not.toBe(true);
				expect(foundText).toContain("SymbolTarget");
				expect(foundText).toContain("src/catalog.py");

				const references = await client.callTool(
					"find_referencing_symbols",
					{ name_path: "SymbolTarget", relative_path: "src/catalog.py" },
					{ timeoutMs: 120_000 },
				);
				const referencesText = references.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n");
				expect(references.isError, `${JSON.stringify(references)}\n${transport.stderr}`).not.toBe(true);
				expect(referencesText).toContain("build_target");
				expect(referencesText).toContain("consume_target");
			} finally {
				await client.close();
			}
		},
		300_000,
	);
});
