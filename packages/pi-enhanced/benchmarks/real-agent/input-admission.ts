import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { atomicPrivateJson } from "../../src/sandbox/audit.ts";
import { digest } from "./evaluation-identity.ts";
import { readTaskPairInput, type TaskPairInput } from "./task-pair-authorization.ts";

interface InputAdmissionOptions {
	auditPath: string;
	evidencePath: string;
	runId: string;
	cwd: string;
	prompt: string;
	provider: string;
	model: string;
	thinking: string;
	maxOutputTokens: number;
	fixtureSha256: string;
	fixtureCommit: string;
	expectedInput?: TaskPairInput;
	expiresAt?: string;
}

/** Check the calibrated first request before forwarding and enforce expiry on later requests. */
export function createInputAdmission(options: InputAdmissionOptions) {
	const {
		auditPath,
		evidencePath,
		runId,
		cwd,
		prompt,
		provider,
		model,
		thinking,
		maxOutputTokens,
		fixtureSha256,
		fixtureCommit,
		expectedInput,
		expiresAt,
	} = options;
	let forwarded = 0;
	let admissionDenied = false;
	const gatedFetch: typeof fetch = (input, init) => {
		try {
			if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.now())
				throw new Error("TASK_PAIR_INPUT_AUTHORIZATION_EXPIRED");
			if (forwarded === 0) {
				const audit = JSON.parse(readFileSync(auditPath, "utf8"));
				if (
					typeof init?.body !== "string" ||
					audit.userPromptSha256 !== digest(prompt) ||
					audit.model !== model ||
					audit.provider !== provider ||
					audit.thinking !== thinking
				)
					throw new Error("TASK_PAIR_INPUT_AUDIT_INVALID");
				const wire = JSON.parse(init.body);
				if (wire.model !== model || wire.max_tokens !== maxOutputTokens)
					throw new Error("TASK_PAIR_INPUT_WIRE_INVALID");
				// Only the system message may contain the ephemeral project root. Keep user text and tools exact.
				for (const message of wire.messages) {
					if (message.role === "system")
						message.content = JSON.parse(
							JSON.stringify(message.content)
								.replaceAll(JSON.stringify(cwd).slice(1, -1), "[PROJECT_ROOT]")
								.replaceAll(cwd.replaceAll("\\", "/"), "[PROJECT_ROOT]"),
						);
				}
				const observed = readTaskPairInput({
					fixtureSha256,
					fixtureCommit,
					userPromptSha256: audit.userPromptSha256,
					systemPromptSha256: audit.canonicalSystemPromptSha256,
					toolSchemaSha256: audit.toolSchemaSha256,
					firstRequestSha256: digest(wire),
				});
				if (expectedInput && !isDeepStrictEqual(observed, expectedInput))
					throw new Error("TASK_PAIR_INPUT_FINGERPRINT_MISMATCH");
				atomicPrivateJson(evidencePath, {
					status: expectedInput ? "matched" : "stub_capture",
					runId,
					input: observed,
				});
			}
		} catch (error) {
			admissionDenied = true;
			atomicPrivateJson(evidencePath, {
				status: "denied",
				runId,
				upstreamForwarded: false,
				previouslyForwarded: forwarded,
				reason:
					error instanceof Error && error.message.startsWith("TASK_PAIR_INPUT_")
						? error.message
						: "TASK_PAIR_INPUT_EVIDENCE_INVALID",
			});
			throw new Error("TASK_PAIR_INPUT_ADMISSION_FAILED");
		}
		forwarded++;
		return globalThis.fetch(input, init);
	};
	return {
		fetch: gatedFetch,
		get denied() {
			return admissionDenied;
		},
		assertForwarded() {
			if (admissionDenied) throw new Error("TASK_PAIR_INPUT_ADMISSION_FAILED");
			if (forwarded === 0) throw new Error("TASK_PAIR_INPUT_NO_REQUEST");
		},
	};
}
