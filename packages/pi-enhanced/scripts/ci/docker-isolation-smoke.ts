import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const expectedImage = process.env.PI_ENHANCED_SMOKE_IMAGE_ID ?? "sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293";
if (!/^sha256:[a-f0-9]{64}$/u.test(expectedImage)) throw new Error("Smoke image must be an explicitly reviewed sha256 image ID");
const inspectedImage = JSON.parse(execFileSync("docker", ["image", "inspect", expectedImage, "--format", "{{json .}}"], { encoding: "utf8", timeout: 15_000 })) as { Id: string; RepoTags?: string[] };
if (inspectedImage.Id !== expectedImage) throw new Error("Local smoke image does not match the reviewed image ID");

const root = mkdtempSync(join(packageRoot, ".batch-f-docker-smoke-"));
const work = join(root, "work"); const readonly = join(root, "readonly"); mkdirSync(work); mkdirSync(readonly);
const sentinel = join(root, "host-sentinel.txt"); writeFileSync(sentinel, "host-only-sentinel\n"); writeFileSync(join(readonly, "locked.txt"), "read-only\n");
const hash = () => createHash("sha256").update(readFileSync(sentinel)).digest("hex"); const beforeHash = hash();
const name = `pi-enhanced-smoke-${randomUUID()}`; let created = false;
const code = `(async()=>{const fs=require('fs'),net=require('net');const denied=f=>{try{f();return false}catch{return true}};const networkBlocked=await new Promise(r=>{const s=net.connect({host:'1.1.1.1',port:53});const done=v=>{s.destroy();r(v)};s.on('connect',()=>done(false));s.on('error',()=>done(true));s.setTimeout(800,()=>done(true))});let workspaceWrite=true;try{fs.writeFileSync('/workspace/inside.txt','ok')}catch{workspaceWrite=false}console.log(JSON.stringify({hostSentinelHidden:denied(()=>fs.readFileSync('/host-sentinel.txt')),readonlyWriteBlocked:denied(()=>fs.writeFileSync('/readonly/new.txt','x')),fakeCredentialHidden:denied(()=>fs.readFileSync('/run/secrets/fake')),rootEscapeBlocked:denied(()=>fs.writeFileSync('/escape.txt','x')),workspaceWrite,networkBlocked}))})()`;
try {
	const id = execFileSync("docker", ["create", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64", "--memory", "128m", "--cpus", "0.5", "--user", "1000:1000", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m", "--mount", `type=bind,src=${work},dst=/workspace`, "--mount", `type=bind,src=${readonly},dst=/readonly,readonly`, expectedImage, "node", "-e", code], { encoding: "utf8", timeout: 20_000 }).trim();
	created = true;
	const inspect = JSON.parse(execFileSync("docker", ["inspect", id, "--format", "{{json .}}"], { encoding: "utf8", timeout: 10_000 })) as { HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; CapDrop: string[]; SecurityOpt: string[]; PidsLimit: number; Memory: number; NanoCpus: number }; Mounts: Array<{ Source: string; Destination: string; RW: boolean }> };
	const output = execFileSync("docker", ["start", "-a", id], { encoding: "utf8", timeout: 15_000 }).trim();
	const result = JSON.parse(output) as Record<string, boolean>; const afterHash = hash();
	const mountsValid = inspect.Mounts.length === 2 && inspect.Mounts.every((mount) => [work, readonly].some((allowed) => resolve(mount.Source) === resolve(allowed)));
	const passed = Object.values(result).every(Boolean) && beforeHash === afterHash && mountsValid && inspect.HostConfig.NetworkMode === "none" && inspect.HostConfig.ReadonlyRootfs;
	const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), status: passed ? "passed" : "failed", image: { id: expectedImage, tags: inspectedImage.RepoTags ?? [] }, container: { network: inspect.HostConfig.NetworkMode, readOnlyRoot: inspect.HostConfig.ReadonlyRootfs, capDrop: inspect.HostConfig.CapDrop, securityOpt: inspect.HostConfig.SecurityOpt, pidsLimit: inspect.HostConfig.PidsLimit, memoryBytes: inspect.HostConfig.Memory, nanoCpus: inspect.HostConfig.NanoCpus, user: "1000:1000", privileged: false, dockerSocketMounted: false, mountDestinations: inspect.Mounts.map(({ Destination, RW }) => ({ destination: Destination, readWrite: RW })) }, checks: result, hostSentinel: { beforeSha256: beforeHash, afterSha256: afterHash, unchanged: beforeHash === afterHash }, mountsValid };
	writeFileSync(join(packageRoot, "docs", "batch-f-sandbox-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ status: report.status, checks: result })}\n`); if (!passed) process.exitCode = 1;
} finally {
	if (created) try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 10_000 }); } catch {}
	rmSync(root, { recursive: true, force: true });
}
