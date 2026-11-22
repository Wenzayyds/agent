import { randomUUID } from "node:crypto";
import type { StepValidation, TaskStep, TaskStepInput } from "./contracts.ts";
import { RISK_CLASSES } from "./contracts.ts";
import { TaskError } from "./errors.ts";

const MAX_TEXT = 4_000;

export function normalizePlan(taskId: string, inputs: readonly TaskStepInput[], maximumSteps: number): TaskStep[] {
	if (inputs.length < 1 || inputs.length > maximumSteps) {
		throw new TaskError("TASK_VALIDATION_ERROR", `A plan must contain 1-${maximumSteps} steps`);
	}
	const steps = inputs.map((input, ordinal): TaskStep => {
		const stepId = input.stepId?.trim() || randomUUID();
		const title = validText(input.title, "step title");
		const expectedOutcome = validText(input.expectedOutcome, "expected outcome");
		const dependsOn = [...new Set(input.dependsOn ?? [])];
		const riskClass = input.riskClass ?? "unknown";
		if (!RISK_CLASSES.includes(riskClass)) throw new TaskError("TASK_VALIDATION_ERROR", "Unknown risk class");
		const validation = input.validation ? normalizeValidation(input.validation) : undefined;
		return {
			stepId,
			taskId,
			ordinal,
			title,
			expectedOutcome,
			dependsOn,
			status: "pending",
			revision: 1,
			riskClass,
			...(validation ? { validation } : {}),
		};
	});
	validateDag(steps);
	return steps;
}

function normalizeValidation(value: StepValidation): StepValidation {
	if (value.kind === "pytest") {
		if (
			typeof value.target !== "string" ||
			value.target.length > 240 ||
			!/^(?:[\w-]+\/)*[\w.-]+\.py(?:::[A-Za-z_]\w*){0,2}$/u.test(value.target) ||
			typeof value.expectedSha256 !== "string" ||
			!/^[a-f0-9]{64}$/u.test(value.expectedSha256)
		)
			throw new TaskError("TASK_VALIDATION_ERROR", "Invalid pytest target or expected test file hash");
		return { kind: "pytest", target: value.target, expectedSha256: value.expectedSha256 };
	}
	if (value.kind === "command_exit") {
		if (
			(value.toolName !== "bash" && value.toolName !== "powershell") ||
			!/^[a-f0-9]{64}$/u.test(value.inputDigest) ||
			!Number.isSafeInteger(value.expectedExitCode)
		)
			throw new TaskError("TASK_VALIDATION_ERROR", "Command validation rule is invalid");
		return { ...value };
	}
	const relativePath = value.relativePath.replaceAll("\\", "/");
	if (
		!relativePath ||
		relativePath.startsWith("/") ||
		/^[a-z]:/iu.test(relativePath) ||
		relativePath.split("/").includes("..") ||
		!/^[a-f0-9]{64}$/u.test(value.expectedSha256)
	)
		throw new TaskError("TASK_VALIDATION_ERROR", "File validation rule is invalid");
	return { kind: "file_sha256", relativePath, expectedSha256: value.expectedSha256 };
}

export function validateDag(steps: readonly Pick<TaskStep, "stepId" | "dependsOn">[]): void {
	const byId = new Map<string, readonly string[]>();
	for (const step of steps) {
		if (!step.stepId || byId.has(step.stepId))
			throw new TaskError("TASK_VALIDATION_ERROR", "Step ids must be unique");
		byId.set(step.stepId, step.dependsOn);
	}
	for (const [id, dependencies] of byId) {
		if (dependencies.includes(id)) throw new TaskError("TASK_VALIDATION_ERROR", "A step cannot depend on itself");
		for (const dependency of dependencies)
			if (!byId.has(dependency)) throw new TaskError("TASK_VALIDATION_ERROR", `Unknown dependency: ${dependency}`);
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) throw new TaskError("TASK_VALIDATION_ERROR", "Task plan contains a dependency cycle");
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of byId.get(id) ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of byId.keys()) visit(id);
}

export function dependenciesComplete(step: TaskStep, steps: readonly TaskStep[]): boolean {
	const byId = new Map(steps.map((item) => [item.stepId, item]));
	return step.dependsOn.every((id) => byId.get(id)?.status === "completed");
}

export function validText(value: string, name: string): string {
	const normalized = value.normalize("NFKC").trim();
	if (!normalized || normalized.length > MAX_TEXT)
		throw new TaskError("TASK_VALIDATION_ERROR", `${name} is empty or too long`);
	return normalized;
}
