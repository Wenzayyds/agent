import type { FetchFunction } from "../types.ts";

/** Check each HTTP attempt immediately before handing it to the transport. */
export function guardedFetch(fetch: FetchFunction | undefined, beforeSend: (() => void) | undefined) {
	if (!beforeSend) return fetch;
	return (input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
		beforeSend();
		return (fetch ?? globalThis.fetch)(input, { ...init, redirect: "error" });
	};
}
