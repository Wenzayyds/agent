import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROLLED_IMAGE } from "../../benchmarks/real-agent/controlled-cases.ts";
import { verifyPatchInDocker } from "../../benchmarks/real-agent/docker-verifier.ts";
import { sandboxConfigForTesting } from "../../src/sandbox/extension.ts";

const available =
	spawnSync("docker", ["image", "inspect", CONTROLLED_IMAGE], { stdio: "ignore", timeout: 10_000 }).status === 0;
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(source: string) {
	const root = mkdtempSync(join(tmpdir(), "pi-verifier-security-"));
	roots.push(root);
	const workspace = join(root, "project");
	mkdirSync(workspace);
	writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
	writeFileSync(join(workspace, "math.js"), source);
	return { root, workspace, config: sandboxConfigForTesting({ workspace }) };
}

describe.skipIf(!available)("Isolated hidden verifier", () => {
	it("runs the real assertion inputs with read-only Docker evidence and cleans up", async () => {
		const { config } = fixture("export const sumTo=n=>n*(n+1)/2;");
		const result = await verifyPatchInDocker("single-file-off-by-one", config);
		expect(result).toMatchObject({
			passed: true,
			status: "passed",
			cleanup: "removed",
			exitCode: 0,
			evidence: {
				image: CONTROLLED_IMAGE,
				network: "none",
				readOnlyRoot: true,
				mounts: [{ destination: "/workspace", readWrite: false }],
			},
		});
		expect(result.evidence?.user).not.toBe("0:0");
		const residue = spawnSync(
			"docker",
			["ps", "-a", "--filter", `id=${result.evidence!.containerId}`, "--format", "{{.ID}}"],
			{ encoding: "utf8" },
		);
		expect(residue.stdout.trim()).toBe("");
	});
	it.each([
		["wrong value", "export const sumTo=()=>0;", "verification_failed"],
		["early exit zero", "process.exit(0); export const sumTo=()=>0;", "protocol_error"],
		["invalid JSON", "process.stdout.write('not json'); export const sumTo=()=>6;", "protocol_error"],
		["exception", "throw new Error('private file body should not be recorded');", "verification_failed"],
		["infinite loop", "while(true){}", "timeout"],
		["output flood", "process.stdout.write('x'.repeat(65536)); export const sumTo=()=>6;", "runtime_error"],
	])(
		"fails closed for %s without persisting raw output",
		async (_label, source, expected) => {
			const { config } = fixture(source!);
			const result = await verifyPatchInDocker("single-file-off-by-one", config, { timeoutMs: 1500 });
			expect(result.passed).toBe(false);
			expect(result.status).toBe(expected);
			expect(result.cleanup).toBe("removed");
			expect(JSON.stringify(result)).not.toContain("private file body");
		},
		30_000,
	);
	it("denies host data, credentials, project writes, root writes and outbound networking", async () => {
		const { root, workspace, config } = fixture("");
		const sentinel = join(root, "outside-sentinel");
		writeFileSync(sentinel, "unchanged");
		const source = `import fs from 'node:fs';let safe=!process.env.PI_VERIFIER_TEST_SECRET&&!fs.existsSync('/var/run/docker.sock');for(const p of [${JSON.stringify(sentinel)},'/proc/1/root/outside-sentinel']){try{fs.readFileSync(p);safe=false}catch{}}for(const p of ['math.js','/root-write','../outside-write']){try{fs.writeFileSync(p,'escaped');safe=false}catch{}}try{await fetch('http://1.1.1.1',{signal:AbortSignal.timeout(500)});safe=false}catch{}export const sumTo=n=>safe?n*(n+1)/2:0;`;
		writeFileSync(join(workspace, "math.js"), source);
		const previous = process.env.PI_VERIFIER_TEST_SECRET;
		process.env.PI_VERIFIER_TEST_SECRET = "synthetic-secret-not-a-real-credential";
		try {
			const result = await verifyPatchInDocker("single-file-off-by-one", config);
			expect(result.passed, JSON.stringify(result)).toBe(true);
		} finally {
			if (previous === undefined) delete process.env.PI_VERIFIER_TEST_SECRET;
			else process.env.PI_VERIFIER_TEST_SECRET = previous;
		}
		expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
		expect(readFileSync(join(workspace, "math.js"), "utf8")).toBe(source);
	});
	it("rejects a replaced workspace before running any verifier container", async () => {
		const { workspace, config } = fixture("export const sumTo=()=>6;");
		renameSync(workspace, `${workspace}-old`);
		mkdirSync(workspace);
		const result = await verifyPatchInDocker("single-file-off-by-one", config);
		expect(result).toMatchObject({
			passed: false,
			status: "runtime_error",
			errorCode: "SANDBOX_WORKSPACE_IDENTITY_CHANGED",
			evidence: null,
			cleanup: "not_needed",
		});
	});
	it("does not run host code when the pinned verifier image is missing", async () => {
		const { config } = fixture("throw new Error('must not execute on host');");
		const result = await verifyPatchInDocker("single-file-off-by-one", {
			...config,
			image: `sha256:${"0".repeat(64)}`,
		});
		expect(result).toMatchObject({ passed: false, status: "runtime_error", evidence: null, cleanup: "not_needed" });
	});
});
