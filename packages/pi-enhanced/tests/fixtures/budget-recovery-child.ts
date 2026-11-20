import { DatabaseSync } from "node:sqlite";
import { DurableBudget } from "../../benchmarks/real-agent/budget-persistence.ts";
import { startBudgetGateway, type BudgetGatewayOptions } from "../../benchmarks/real-agent/budget-gateway.ts";

const options = JSON.parse(process.argv[2]) as BudgetGatewayOptions;
try {
	if (process.argv[3] === "prepared") {
		const store = new DatabaseSync(options.persistence!.databasePath);
		const row = store.prepare("SELECT body FROM gateway_budget_runs WHERE id=?").get(options.persistence!.id) as { body: string };
		store.close();
		const original = JSON.parse(row.body);
		const budget = new DurableBudget({ ...options.persistence!, mode: "resume" }, original.policy, original.status);
		const status = budget.snapshot();
		status.requestsStarted += 1;
		status.requestAttempts += 1;
		status.activeRequests = 1;
		status.reservedTokens = 4300;
		status.reservedCostUsd = 0.002;
		budget.save(status, { requestSequence: status.requestAttempts, phase: "reserved", tokens: 4300, costUsd: 0.002, updatedAt: Date.now() });
		process.send!({ stage: "prepared" });
		await new Promise<void>(() => { setInterval(() => {}, 1000); });
	}
	const gateway = await startBudgetGateway(options);
	process.send!({ url: gateway.url, deadlineAt: gateway.deadlineAt, status: gateway.status() });
	process.on("message", async (command) => {
		if (command === "status") process.send!({ status: gateway.status() });
		if (command === "close") {
			await gateway.close();
			process.disconnect();
		}
	});
} catch (error) {
	process.send!({ error: error instanceof Error ? error.message : String(error) });
	process.disconnect();
}
