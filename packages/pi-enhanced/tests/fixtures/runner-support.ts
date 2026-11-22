import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONTROLLED_IMAGE } from "../../benchmarks/real-agent/controlled-cases.ts";
import type { SandboxConfig } from "../../src/sandbox/config.ts";
export function dockerImageAvailable(image = CONTROLLED_IMAGE): boolean {
	return spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 10000 }).status === 0;
}
export type StubHandler = (body: Record<string, unknown>, response: ServerResponse) => void | Promise<void>;
export async function startStubProvider(handler: StubHandler, registry?: Server[]) {
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			assert.equal(request.headers.authorization, "Bearer mock-upstream-key");
			await handler(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>, response);
		})().catch((error: unknown) => {
			response.destroy(new Error("Stub provider handler failed"));
			// Preserve the original fixtures' assertion failures; never turn them into an accepted Stub response.
			throw error;
		});
	});
	await new Promise<void>((done, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("provider listen failed");
	registry?.push(server);
	return { url: `http://127.0.0.1:${address.port}`, server };
}
export function close(server: Server): Promise<void> {
	return new Promise((done) => server.close(() => done()));
}
export function toolCallSse(name: string, args: Record<string, unknown>, input: number, output: number): string {
	return toolCallsSse([{ name, args }], input, output);
}
export function toolCallsSse(
	calls: { name: string; args: Record<string, unknown> }[],
	input: number,
	output: number,
	distinguishCalls = false,
): string {
	return responseSse(
		{
			role: "assistant",
			tool_calls: calls.map(({ name, args }, index) => ({
				index,
				id: distinguishCalls ? `call-${name}-${input}-${index}` : `call-${name}-${input}`,
				type: "function",
				function: { name, arguments: JSON.stringify(args) },
			})),
		},
		"tool_calls",
		`chatcmpl-${calls[0].name}-${input}`,
		input,
		output,
	);
}
export function textSse(text: string, input: number, output: number): string {
	return responseSse({ role: "assistant", content: text }, "stop", "chatcmpl-final", input, output);
}
function responseSse(
	delta: Record<string, unknown>,
	reason: string,
	id: string,
	input: number,
	output: number,
): string {
	const chunk = {
		id,
		object: "chat.completion.chunk",
		created: 1,
		model: "deepseek-flash",
		choices: [{ index: 0, delta, finish_reason: null }],
	};
	const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: reason }] };
	return `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } })}\n\ndata: [DONE]\n\n`;
}
export function assertIsolatedMount(value: unknown, readWrite: boolean): void {
	const evidence = value as { network: string; readOnlyRoot: boolean; user: string; mounts: unknown[] };
	assert.equal(evidence.network, "none");
	assert.equal(evidence.readOnlyRoot, true);
	assert.match(evidence.user, /^[1-9][0-9]*:[1-9][0-9]*$/u);
	assert.deepEqual(evidence.mounts, [{ destination: "/workspace", readWrite }]);
}
export function createSandboxFixture(prefix: string, files: Record<string, string> = {}) {
	const root = mkdtempSync(join(tmpdir(), prefix)),
		workspace = join(root, "project");
	mkdirSync(workspace);
	for (const [name, content] of Object.entries(files)) writeFileSync(join(workspace, name), content);
	return { root, workspace, config: sandboxConfigForTesting({ workspace }) };
}
export function sandboxConfigForTesting(overrides: Partial<SandboxConfig>): SandboxConfig {
	const workspace = overrides.workspace ?? process.cwd();
	const stat = lstatSync(workspace);
	return {
		enabled: true,
		trusted: true,
		runId: "sandbox-test",
		runRoot: dirname(workspace),
		workspace,
		workspaceDevice: stat.dev,
		workspaceInode: stat.ino,
		image: CONTROLLED_IMAGE,
		timeoutMs: 10_000,
		maxRequestBytes: 1024 * 1024,
		maxResponseBytes: 2 * 1024 * 1024,
		...overrides,
	};
}
