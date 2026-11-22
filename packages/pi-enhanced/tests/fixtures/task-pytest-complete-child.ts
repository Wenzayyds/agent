import { createEventBus } from "../../../coding-agent/src/core/event-bus.ts";
import { createProjectScope } from "../../src/memory/project-scope.ts";
import { registerTaskPytestSource, taskPytestSource } from "../../src/sandbox/task-evidence.ts";
import { createTaskStorageScope, TaskProvider } from "../../src/task-manager/provider.ts";
import { TaskService } from "../../src/task-manager/service.ts";
import { sandboxConfigForTesting } from "./runner-support.ts";

const [workspace, agentDir, taskId, image] = process.argv.slice(2);
if (!workspace || !agentDir || !taskId || !image) throw new Error("Missing fixture arguments");
const scope = createProjectScope({ cwd: workspace, agentDir });
const events = createEventBus();
const policy = { image, files: ["calc.py", "test_calc.py"], tests: ["test_calc.py"] };
const source = registerTaskPytestSource(events, sandboxConfigForTesting({ workspace }), policy, () => true);
const service = new TaskService(new TaskProvider(createTaskStorageScope(scope, agentDir)), 20,
	() => taskPytestSource(events, workspace));
try {
	service.transitionStep(taskId, "repair", 3, "completed");
	process.stdout.write("completed");
} catch (error) {
	if (!(error instanceof Error && "code" in error && error.code === "TASK_REVISION_CONFLICT")) throw error;
	process.stdout.write("revision_conflict");
} finally {
	service.close();
	source.close();
}
