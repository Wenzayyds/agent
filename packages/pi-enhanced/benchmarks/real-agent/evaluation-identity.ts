import { createHash } from "node:crypto";

export function digest(value: unknown): string {
	return digestBytes(typeof value === "string" ? value : JSON.stringify(value));
}

export function digestBytes(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
