import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSandboxContainerOwner, SANDBOX_CONTAINER_OWNER_LABEL } from "../../src/sandbox/config.ts";
import type { BudgetGatewayStatus, RunningBudgetGateway } from "./budget-gateway.ts";
import { gatewayEvidence } from "./gateway-integration.ts";

/** Drain the gateway before writing its final ledger, and attempt container cleanup independently. */
export async function finalizeAgentExecution(
	gateway: Pick<RunningBudgetGateway, "status" | "close" | "finalStatus">,
	evidenceDir: string | undefined,
	removeContainers?: () => boolean,
	executionFailure?: { error: unknown },
) {
	const errors: unknown[] = [];
	let gatewayStatus: BudgetGatewayStatus | undefined;
	let containersRemoved = false;
	let closeFailure: { error: unknown } | undefined;
	let before: BudgetGatewayStatus | undefined;
	try { before = gateway.status(); } catch (error) { errors.push(error); }
	try { await gateway.close(); } catch (error) { closeFailure = { error }; }
	try {
		gatewayStatus = gateway.finalStatus?.() ?? before;
		if (evidenceDir && gatewayStatus) {
			mkdirSync(evidenceDir, { recursive: true });
			writeFileSync(join(evidenceDir, "gateway-final.json"), JSON.stringify(gatewayEvidence(gatewayStatus), null, 2));
		}
	} catch (error) {
		errors.push(error);
	}
	if (closeFailure) errors.push(closeFailure.error);
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
