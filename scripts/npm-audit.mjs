// Scan production dependencies with npm's own severity and exit-code handling.
import { execSync } from "node:child_process";

try {
	execSync("npm audit --omit=dev --audit-level=moderate", { stdio: "inherit" });
} catch (error) {
	process.exitCode = error.status || 1;
}
