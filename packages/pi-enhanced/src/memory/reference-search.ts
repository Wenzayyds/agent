import type { MemoryRecord } from "./contracts.ts";

/** Keep literal search semantics first; retry only bounded code identifiers on zero hits. */
export async function searchMemoryReferences(
	text: string,
	search: (text: string) => Promise<readonly MemoryRecord[]>,
	allowPhrases = false,
): Promise<{
	records: readonly MemoryRecord[];
	strategy: "literal" | "code-identifier" | "phrase";
	queries: readonly string[];
}> {
	const queries = [text];
	const records = await search(text);
	if (records.length) return { records, strategy: "literal", queries };
	const identifiers = [
		...new Set((text.match(/[A-Za-z_$][A-Za-z0-9_$]{2,79}/gu) ?? []).filter((term) => /[a-z][A-Z]|_/u.test(term))),
	].slice(0, 3);
	for (const term of identifiers) {
		if (term === text) continue;
		queries.push(term);
		const found = await search(term);
		if (found.length) return { records: found, strategy: "code-identifier", queries };
	}
	const terms = text.trim().split(/\s+/u);
	if (
		allowPhrases &&
		terms.length >= 3 &&
		terms.length <= 12 &&
		terms.every((term) => /^[\p{L}\p{N}_-]+$/u.test(term))
	) {
		const phrases = new Set([
			terms.slice(-3).join(" "),
			terms.slice(0, 3).join(" "),
			terms.slice(1, 3).join(" "),
			terms.slice(-2).join(" "),
		]);
		phrases.delete(terms.join(" "));
		for (const phrase of phrases) {
			queries.push(phrase);
			const found = await search(phrase);
			if (found.length) return { records: found, strategy: "phrase", queries };
		}
	}
	return { records, strategy: "literal", queries };
}
