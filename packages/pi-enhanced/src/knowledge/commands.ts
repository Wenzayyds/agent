import { basename, dirname, isAbsolute, normalize } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KnowledgeDocumentError } from "./contracts.ts";
import { CORPUS_ID, errorCode, type KnowledgeService } from "./service.ts";
import { discoverDocumentSources } from "./sources.ts";

const USAGE =
	"/enhanced-docs add [--recursive] [--allow-external] [--corpus=ID] <absolute path or JSON array> | list [corpus] [offset] | sync [--rebuild] [documentId] | sync --maintain | remove <documentId> | status";

export async function runKnowledgeCommand(args: string, ctx: ExtensionCommandContext, service: KnowledgeService) {
	const [command] = args.trim().split(/\s+/u, 1);
	const rest = args.trim().slice(command.length).trim();
	try {
		switch (command) {
			case "status":
				if (rest) throw new KnowledgeDocumentError("invalid-parameter");
				ctx.ui.notify(JSON.stringify(service.status()), "info");
				break;
			case "list": {
				const [corpus, offset, ...extra] = rest.split(/\s+/u);
				const start = offset ? Number(offset) : 0;
				if (extra.length || !Number.isSafeInteger(start) || start < 0)
					throw new KnowledgeDocumentError("invalid-parameter");
				const all = service.list(corpus && corpus !== "*" ? corpus : undefined);
				ctx.ui.notify(JSON.stringify({ total: all.length, documents: all.slice(start, start + 10) }), "info");
				break;
			}
			case "add":
				await add(rest, ctx, service);
				break;
			case "sync": {
				if (rest === "--maintain") {
					ctx.ui.notify(JSON.stringify(await service.maintain()), "info");
					break;
				}
				const rebuild = rest === "--rebuild" || rest.startsWith("--rebuild ");
				const id = rebuild ? rest.slice("--rebuild".length).trim() : rest;
				const result = await service.sync(id || undefined, rebuild);
				ctx.ui.notify(JSON.stringify({ count: result.length, outcomes: summarize(result) }), "info");
				break;
			}
			case "remove": {
				if (!/^[a-f0-9]{64}$/u.test(rest)) throw new KnowledgeDocumentError("invalid-parameter");
				const target = service.list().find(({ id }) => id === rest);
				if (!target) throw new KnowledgeDocumentError("document-not-found");
				if (
					!ctx.hasUI ||
					!(await ctx.ui.confirm("移除文档", `从知识库移除 ${JSON.stringify(target.source)}（${target.id}）？`))
				) {
					ctx.ui.notify("文档移除未确认。", "info");
					break;
				}
				await service.remove(target.id);
				ctx.ui.notify(`已移除 ${target.id}`, "info");
				break;
			}
			default:
				ctx.ui.notify(USAGE, "warning");
		}
	} catch (error) {
		const code = errorCode(error);
		if (["add", "list", "remove", "status", "sync"].includes(command)) service.audit(`command-${command}`, code);
		ctx.ui.notify(`Knowledge 操作失败（${code}）。`, "warning");
	}
}

async function add(args: string, ctx: ExtensionCommandContext, service: KnowledgeService) {
	let corpus = "default";
	let recursive = false;
	let external = false;
	while (args.startsWith("--")) {
		const [arg] = args.split(/\s+/u, 1);
		args = args.slice(arg.length).trim();
		if (arg === "--") break;
		if (arg === "--recursive") recursive = true;
		else if (arg === "--allow-external") external = true;
		else if (arg.startsWith("--corpus=")) corpus = arg.slice("--corpus=".length);
		else throw new KnowledgeDocumentError("invalid-parameter");
	}
	let paths: unknown;
	try {
		paths = args.startsWith("[") ? JSON.parse(args) : [args.replace(/^"(.*)"$/su, "$1")];
	} catch {
		throw new KnowledgeDocumentError("invalid-parameter");
	}
	if (
		!CORPUS_ID.test(corpus) ||
		!Array.isArray(paths) ||
		!paths.length ||
		paths.length > 128 ||
		paths.some((path) => typeof path !== "string" || !isAbsolute(path) || !basename(normalize(path)))
	) {
		throw new KnowledgeDocumentError("invalid-parameter");
	}
	if (external) {
		const approvedPaths = JSON.stringify(paths);
		if (approvedPaths.length > 2_400) throw new KnowledgeDocumentError("limit-exceeded");
		if (
			!ctx.hasUI ||
			!(await ctx.ui.confirm(
				"允许文档外发",
				`允许在线模型读取以下选定范围的正文与引用元数据？${recursive ? "包含子目录。" : ""} ${approvedPaths}`,
			))
		)
			return;
	}
	const targets = new Map<string, { root: string; source: string }>();
	for (const path of paths as string[]) {
		const absolute = normalize(path);
		const root = dirname(absolute);
		const selected = await discoverDocumentSources(root, basename(absolute), { recursive });
		for (const source of selected) {
			targets.set(JSON.stringify([root, source]), { root, source });
			if (targets.size > 128) throw new KnowledgeDocumentError("limit-exceeded");
		}
	}
	const results: { outcome: string }[] = [];
	for (const { root, source } of targets.values()) {
		try {
			results.push(await service.add(root, source, corpus, external ? "allow-external" : "local-only"));
		} catch (error) {
			const code = errorCode(error);
			service.audit("command-add", code);
			results.push({ outcome: code });
		}
	}
	ctx.ui.notify(JSON.stringify({ selected: targets.size, outcomes: summarize(results) }), "info");
}

function summarize(results: readonly { outcome: string }[]) {
	const counts = new Map<string, number>();
	for (const { outcome } of results) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
	return Object.fromEntries(counts);
}
