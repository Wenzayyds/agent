import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const providerId = "local-ccr";
const flash = "DeepSeek/deepseek-flash";
const pro = "DeepSeek/deepseek-v4-pro";

async function main() {
	const { values } = parseArgs({
		options: {
			profile: { type: "string", default: "search" },
			strategy: { type: "string" },
			model: { type: "string" },
			check: { type: "boolean" },
		},
	});
	const profiles = new Map([["search", flash], ["complex", pro]]);
	const models = new Map([["flash", flash], ["pro", pro]]);
	const profileModel = profiles.get(values.profile);
	if (!profileModel) throw new Error("选择 --profile search 或 --profile complex。");
	const strategy = values.strategy;
	if (strategy !== undefined && !["manual", "auto", "strong"].includes(strategy))
		throw new Error("选择 --strategy manual、auto 或 strong。");
	if (strategy === "manual" && values.model === undefined) throw new Error("manual 策略要求显式 --model。");
	const model = values.model !== undefined ? models.get(values.model) : strategy === "strong" ? pro : profileModel;
	if (!model) throw new Error("选择 --model flash 或 --model pro。");

	const agentDir = process.env.PI_CCR_AGENT_DIR;
	const token = process.env.PI_CCR_TOKEN;
	if (!agentDir || !isAbsolute(agentDir) || !token?.trim()) {
		throw new Error("请设置 PI_CCR_AGENT_DIR（可信用户目录的绝对路径）和 PI_CCR_TOKEN。");
	}
	const { providers } = readConfig(agentDir, "models.json");
	const provider = providers?.[providerId];
	const baseUrl = provider?.baseUrl;
	if (
		typeof baseUrl !== "string" ||
		!/^http:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?\/v1$/.test(baseUrl) ||
		provider.api !== "openai-completions" ||
		provider.apiKey !== "$PI_CCR_TOKEN" ||
		Object.keys(providers).length !== 1 ||
		!Array.isArray(provider.models) ||
		provider.models.length !== 2 ||
		provider.models.some((entry) => !entry || entry.api !== undefined || entry.baseUrl !== undefined) ||
		![flash, pro].every((id) => provider.models.some((entry) => entry?.id === id))
	) {
		throw new Error("models.json 须按 README 配置本机 local-ccr Provider 和两个 DeepSeek 模型。");
	}
	const { retry } = readConfig(agentDir, "settings.json");
	if (retry?.enabled !== false || retry.provider?.maxRetries !== 0) {
		throw new Error("settings.json 须关闭 Pi 会话及 Provider 自动重试。");
	}

	let discovered;
	try {
		const response = await fetch(baseUrl + "/models", {
			headers: { Authorization: "Bearer " + token },
			redirect: "error",
			signal: AbortSignal.timeout(3000),
		});
		if (response.status === 401 || response.status === 403) throw new Error("auth");
		if (!response.ok) throw new Error("unavailable");
		discovered = await response.json();
	} catch (error) {
		throw new Error(error.message === "auth" ? "CCR 拒绝客户端令牌。" : "CCR 不可用，请检查本机服务和端口。");
	}
	if (
		!Array.isArray(discovered?.data) ||
		discovered.data.length !== 2 ||
		![flash, pro].every((id) => discovered.data.some((entry) => entry?.id === id))
	) {
		throw new Error("CCR 须只登记 Flash 和 Pro，请检查其 Provider 配置。");
	}
	const selection = values.model ? "显式选择" : strategy === "strong" ? "strong" : strategy === "auto" ? "auto/" + values.profile : values.profile;
	console.log("CCR " + baseUrl + " · " + model + " · " + selection);
	if (values.check) return;

	const adaptive = strategy === "auto" && values.model === undefined && model === flash;

	const cli = fileURLToPath(new URL("../../coding-agent/dist/bundle/cli.js", import.meta.url));
	if (!existsSync(cli)) throw new Error("Pi CLI 尚未构建，请先构建 packages/coding-agent。");
	const scoped = (adaptive ? [flash, pro] : [model]).map((id) => providerId + "/" + id).join(",");
	const isolated = adaptive ? [
		"--no-extensions", "--no-mcp", "--no-builtin-tools",
		"-e", fileURLToPath(new URL("../src/ccr/ccr-auto.ts", import.meta.url)),
	] : [];
	const child = spawn(process.execPath, [
		cli, "--offline", "--no-approve", "--provider", providerId, "--model", model,
		"--models", scoped, "--thinking", "off", ...isolated,
	], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: "inherit" });
	child.once("error", () => { console.error("无法启动 Pi CLI。"); process.exitCode = 1; });
	child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
}

function readConfig(agentDir, file) {
	try {
		const config = JSON.parse(readFileSync(join(agentDir, file), "utf8"));
		if (config && typeof config === "object" && !Array.isArray(config)) return config;
	} catch {
		// Config errors can embed file contents. Report the filename only.
	}
	throw new Error("无法读取可信 Pi 配置 " + file + "。");
}

main().catch((error) => {
	console.error("CCR 启动检查失败。" + (error.code?.startsWith("ERR_PARSE_ARGS") ? "可用参数为 --strategy、--profile、--model 和 --check。" : error.message));
	process.exitCode = 1;
});
