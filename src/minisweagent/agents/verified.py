"""Keep mini's loop; verify the patch and tests before accepting submission."""

import hashlib
import re
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass

from minisweagent.agents.default import DefaultAgent
from minisweagent.utils.wz_repository import PatchReview, Repository

SUBMIT = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"


def classify_failure(output: dict) -> str:
    text = (str(output.get("output", "")) + str(output.get("exception_info", ""))).lower()
    if re.search(r"ran 0 tests|no tests ran|no tests collected|collected 0 items", text):
        return "no_tests_collected"
    if output.get("returncode") == 0:
        return "passed"
    if output.get("extra", {}).get("exception_type") == "TimeoutExpired" or "timed out" in text:
        return "timeout"
    if any(item in text for item in ("cannot connect to the docker", "dockerdesktoplinuxengine")):
        return "environment_missing"
    if "permission denied" in text or "access is denied" in text:
        return "permission_denied"
    if any(item in text for item in ("no module named", "modulenotfounderror", "cannot find module", "importerror")):
        return "dependency_missing"
    if output.get("returncode") in (126, 127) or "command not found" in text or "not recognized" in text:
        return "command_missing"
    if "could not resolve" in text or "network is unreachable" in text:
        return "network_error"
    if "syntaxerror" in text or "indentationerror" in text:
        return "code_compile_failed"
    if any(item in text for item in ("assertionerror", "assert ", "failed (", " failed", "not ok ")):
        return "unit_test_failed"
    return "unknown"


@dataclass
class VerificationPolicy:
    test_commands: tuple[str, ...]
    max_repairs: int = 2
    test_timeout: int = 120
    max_files: int = 5
    max_lines: int = 500

    def __post_init__(self) -> None:
        if not self.test_commands or any(not command.strip() for command in self.test_commands):
            raise ValueError("At least one explicit test command is required.")
        if self.max_repairs < 0 or min(self.test_timeout, self.max_files, self.max_lines) <= 0:
            raise ValueError("Invalid verification limits.")


class VerifiedAgent(DefaultAgent):
    def __init__(
        self,
        model,
        env,
        *,
        repository: Repository,
        policy: VerificationPolicy,
        approve: Callable[[PatchReview], bool],
        **kwargs,
    ):
        super().__init__(model, env, **kwargs)
        self.repository = repository
        self.policy = policy
        self.approve = approve
        self.verifications: list[dict] = []
        self.repair_count = 0

    def finish(self, status: str, submission: str = "") -> list[dict]:
        return self.add_messages(
            self.model.format_message(
                role="exit",
                content=status,
                extra={"exit_status": status, "submission": submission, "repair_count": self.repair_count},
            )
        )

    def execute_actions(self, message: dict) -> list[dict]:
        actions = message.get("extra", {}).get("actions", [])
        # One action avoids tool-call responses being orphaned when a submission ends the run.
        if len(actions) != 1:
            raise ValueError("VerifiedAgent requires exactly one action per response.")
        output = self.env.execute(actions[0])
        lines = output.get("output", "").lstrip().splitlines()
        if output.get("returncode") == 0 and lines and lines[0].strip() == SUBMIT:
            return self.verify_submission(message)
        return self.add_messages(*self.model.format_observation_messages(message, [output], self.get_template_vars()))

    def verify_submission(self, message: dict) -> list[dict]:
        started = time.monotonic()
        review = self.repository.review(self.policy.max_files, self.policy.max_lines)
        record = {
            "attempt": len(self.verifications) + 1,
            "files": review.files,
            "added": review.added,
            "deleted": review.deleted,
            "findings": review.findings,
            "patch_sha256": hashlib.sha256(review.diff.encode()).hexdigest(),
            "tests": [],
            "approved": False,
        }
        self.verifications.append(record)
        if review.findings:
            record["status"] = "policy_rejected"
            return self.finish("PolicyRejected")
        failures = []
        for command in self.policy.test_commands:
            result = self.env.execute({"command": command}, timeout=self.policy.test_timeout)
            category = classify_failure(result)
            record["tests"].append(
                {
                    "command": command,
                    "category": category,
                    "returncode": result.get("returncode"),
                    "output": result.get("output", "")[-8000:],
                    "exception_info": result.get("exception_info", ""),
                }
            )
            if category != "passed":
                failures.append(category)
                if category not in {"code_compile_failed", "unit_test_failed"}:
                    break
        record["duration_ms"] = int((time.monotonic() - started) * 1000)
        # Tests may write files. Approve exactly the patch that was checked and tested.
        after = self.repository.review(self.policy.max_files, self.policy.max_lines)
        if after.diff != review.diff or after.findings:
            record["status"] = "workspace_changed_during_tests"
            return self.finish("WorkspaceChangedDuringTests")
        if failures:
            if any(category not in {"code_compile_failed", "unit_test_failed"} for category in failures):
                record["status"] = "environment_or_unknown_failure"
                return self.finish("VerificationBlocked")
            if self.repair_count >= self.policy.max_repairs:
                record["status"] = "repair_exhausted"
                return self.finish("RepairExhausted")
            self.repair_count += 1
            record["status"] = "repair_requested"
            feedback = "Submission rejected: tests failed. Continue inspecting and repairing the current patch.\n"
            feedback += "\n".join(
                f"COMMAND: {run['command']}\nCATEGORY: {run['category']}\n{run['output']}\n{run['exception_info']}"
                for run in record["tests"]
            )
            return self.add_messages(
                *self.model.format_observation_messages(
                    message,
                    [{"output": feedback, "returncode": 1, "exception_info": ""}],
                    self.get_template_vars(),
                )
            )
        (self.repository.session / "candidate.patch").write_text(review.diff, encoding="utf-8")
        record["approved"] = self.approve(review)
        if not record["approved"]:
            record["status"] = "approval_declined"
            return self.finish("ApprovalDeclined")
        final = self.repository.review(self.policy.max_files, self.policy.max_lines)
        if final.diff != review.diff or final.findings:
            record["status"] = "workspace_changed_during_approval"
            return self.finish("WorkspaceChangedDuringApproval")
        (self.repository.session / "approved.patch").write_text(review.diff, encoding="utf-8")
        record["status"] = "verified"
        return self.finish("Verified", review.diff)

    def serialize(self, *extra_dicts) -> dict:
        return super().serialize(
            {
                "verification": {
                    "policy": asdict(self.policy),
                    "base_commit": self.repository.base,
                    "repair_count": self.repair_count,
                    "attempts": self.verifications,
                }
            },
            *extra_dicts,
        )
