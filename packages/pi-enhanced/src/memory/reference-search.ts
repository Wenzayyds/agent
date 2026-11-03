import type { MemoryRecord } from "./contracts.ts";

/** Keep literal search semantics first; retry only bounded code identifiers on zero hits. */
export async function searchMemoryReferences(
	text: string,
	search: (text: string) => Promise<readonly MemoryRecord[]>,
): Promise<{ records: readonly MemoryRecord[]; strategy: "literal" | "code-identifier"; queries: readonly string[] }> {
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
	return { records, strategy: "literal", queries };
}
