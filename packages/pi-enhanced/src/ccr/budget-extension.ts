import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { installCcrSessionBudget } from "../context/session-budget.ts";

export default function ccrBudgetExtension(pi: ExtensionAPI): void {
	installCcrSessionBudget(pi, getAgentDir());
}
