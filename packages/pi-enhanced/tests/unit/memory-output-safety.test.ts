import { describe, expect, it } from "vitest";
import { redactMemoryOutput } from "../../src/memory/output-safety.ts";

describe("Memory path redaction", () => {
	it("recognizes Windows drive paths regardless of case and slash style", () => {
		expect(redactMemoryOutput("Workspace root: d:\\A\\Project", "D:\\a\\project")).toBe("Workspace root: [PROJECT_PATH]");
		expect(redactMemoryOutput("d:/A/Project", "D:\\a\\project")).toBe("[PROJECT_PATH]");
		expect(redactMemoryOutput("/home/User/repo", "/home/user/repo")).toBe("[REDACTED_PATH]");
	});
});
