import { execFileSync } from "node:child_process";

export function runSweGit(cwd: string, args: string[], input?: string): string {
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
	return execFileSync(
		"git",
		[
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.autocrlf=false",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"submodule.recurse=false",
			"-c",
			"protocol.file.allow=always",
			...args,
		],
		{
			cwd,
			env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
			encoding: "utf8",
			input,
			timeout: 60_000,
			maxBuffer: 4 * 1024 * 1024,
			windowsHide: true,
		},
	);
}
