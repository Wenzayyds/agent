import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSandboxContainerOwner, SANDBOX_CONTAINER_OWNER_LABEL } from "../../src/sandbox/config.ts";
import type { BudgetGatewayStatus, RunningBudgetGateway } from "./budget-gateway.ts";
import { gatewayEvidence } from "./gateway-integration.ts";

/** Preserve the pre-close ledger and attempt each cleanup even if evidence cannot be written. */
export async function finalizeAgentExecution(
	gateway: Pick<RunningBudgetGateway, "status" | "close">,
	evidenceDir: string | undefined,
	removeContainers?: () => boolean,
	executionFailure?: { error: unknown },
) {
	const errors: unknown[] = [];
	let gatewayStatus: BudgetGatewayStatus | undefined;
	let containersRemoved = false;
	try {
		gatewayStatus = gateway.status();
		if (evidenceDir) {
			mkdirSync(evidenceDir, { recursive: true });
			writeFileSync(join(evidenceDir, "gateway-final.json"), JSON.stringify(gatewayEvidence(gatewayStatus), null, 2));
		}
	} catch (error) {
		errors.push(error);
	}
	try {
		await gateway.close();
	} catch (error) {
		errors.push(error);
	}
	try {
		containersRemoved = removeContainers?.() ?? false;
	} catch (error) {
		errors.push(error);
	}
	if (errors.length) {
		if (executionFailure) errors.unshift(executionFailure.error);
		if (errors.length === 1) throw errors[0];
		throw new AggregateError(errors, errors.map(String).join("; "));
	}
	return { gatewayStatus: gatewayStatus!, containersRemoved };
}

export function removeRunContainers(containerOwner: string): boolean {
	assertSandboxContainerOwner(containerOwner);
	const ownerFilter = "label=" + SANDBOX_CONTAINER_OWNER_LABEL + "=" + containerOwner;
	const list = () =>
		execFileSync(
			"docker",
			["ps", "-a", "--no-trunc", "--filter", ownerFilter, "--format", "{{.ID}}"],
			{ encoding: "utf8", timeout: 10_000, windowsHide: true },
		)
			.trim()
			.split(/\s+/u)
			.filter(Boolean);
	for (const id of list()) {
		if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("EVAL_SANDBOX_CLEANUP_ID_INVALID");
		execFileSync("docker", ["rm", "-f", id], { timeout: 10_000, windowsHide: true, stdio: "ignore" });
	}
	return list().length === 0;
}
