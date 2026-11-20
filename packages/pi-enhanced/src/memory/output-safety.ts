const PRIVATE_KEY_PATTERN =
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gu;

export function redactMemoryOutput(value: string, projectRoot?: string): string {
	let redacted = value;
	if (projectRoot) {
		for (const path of new Set([projectRoot, projectRoot.replaceAll("\\", "/"), projectRoot.replaceAll("/", "\\")])) {
			if (path) {
				const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
				redacted = redacted.replace(
					new RegExp(escaped, /^[A-Za-z]:[\\/]/u.test(path) ? "giu" : "gu"),
					"[PROJECT_PATH]",
				);
			}
		}
	}
	return redacted
		.replace(PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]")
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "[REDACTED_TOKEN]")
		.replace(/\bghp_[A-Za-z0-9]{20,}\b/gu, "[REDACTED_TOKEN]")
		.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED_TOKEN]")
		.replace(/\bAKIA[A-Z0-9]{16}\b/gu, "[REDACTED_TOKEN]")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/giu, "Bearer [REDACTED]")
		.replace(
			/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gu,
			"$1=[REDACTED]",
		)
		.replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{8,}["']?/giu, "$1=[REDACTED]")
		.replace(/\b[A-Za-z]:[\\/](?:[^\\/\s"'<>|]+[\\/])*[^\\/\s"'<>|]*/gu, "[REDACTED_PATH]")
		.replace(/\/(?:home|Users)\/[^\s"'<>]+/gu, "[REDACTED_PATH]");
}

export function truncateMemoryOutput(value: string, maximumCharacters: number): string {
	const characters = [...value];
	if (characters.length <= maximumCharacters) return value;
	const marker = [..."\n[TRUNCATED]"];
	if (maximumCharacters <= marker.length) return marker.slice(0, maximumCharacters).join("");
	return [...characters.slice(0, maximumCharacters - marker.length), ...marker].join("");
}
