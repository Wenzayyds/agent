"""Independent patch checks before a full SWE-agent submission is accepted."""

import asyncio
import hashlib
import json
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from swerex.runtime.abstract import BashAction
from unidiff import PatchSet, UnidiffParseError

from sweagent.agent.agents import DefaultAgent
from sweagent.types import StepOutput
from sweagent.wz.repository import PatchReview, is_test, protected_path


@dataclass(frozen=True)
class VerificationPolicy:
    test_commands: tuple[str, ...]
    max_repairs: int = 2
    test_timeout: int = 120
    max_files: int = 5
    max_lines: int = 500

    def __post_init__(self) -> None:
        if not self.test_commands or any(not command.strip() for command in self.test_commands):
            msg = "At least one test command is required"
            raise ValueError(msg)
        if self.max_repairs < 0 or min(self.test_timeout, self.max_files, self.max_lines) <= 0:
            msg = "Invalid verification limits"
            raise ValueError(msg)


def review_submission(diff: str, policy: VerificationPolicy) -> PatchReview:
    findings = []
    try:
        patch = PatchSet(diff.splitlines(keepends=True))
    except UnidiffParseError:
        patch = []
        findings.append("invalid_patch")
    files = []
    added = deleted = 0
    if not diff.strip() or not patch:
        findings.append("empty_patch")
    for item in patch:
        path = item.path
        files.append(path)
        added += item.added
        deleted += item.removed
        if item.is_binary_file:
            findings.append("binary_patch")
        if protected_path(path):
            findings.append(f"protected_path:{path}")
        if is_test(path):
            findings.append(f"test_modified:{path}")
    if len(files) > policy.max_files or added + deleted > policy.max_lines:
        findings.append("patch_size_exceeded")
    return PatchReview(diff, files, added, deleted, findings)


def classify_test(output: str, returncode: int | None) -> str:
    lowered = output.lower()
    if re.search(r"ran 0 tests|no tests ran|no tests collected|collected 0 items", lowered):
        return "no_tests_collected"
    if returncode == 0:
        return "passed"
    if any(word in lowered for word in ("modulenotfounderror", "no module named", "cannot find module")):
        return "dependency_missing"
    if "syntaxerror" in lowered or "indentationerror" in lowered:
        return "code_compile_failed"
    if "assertionerror" in lowered or " failed" in lowered or "not ok " in lowered:
        return "unit_test_failed"
    return "unknown"


class VerifiedSWEAgent(DefaultAgent):
    """Use upstream's Agent Loop; intercept only completed submissions."""

    def configure_verification(
        self, policy: VerificationPolicy, session: Path, approve: Callable[[PatchReview], bool]
    ) -> None:
        self.verification_policy = policy
        self.verification_session = session
        self.approve_patch = approve
        self.verifications: list[dict] = []
        self.repair_count = 0

    def _run_test(self, command: str) -> tuple[str, int | None]:
        assert self._env is not None
        # A fast repair can change a same-sized Python file within one second.
        # Use a fresh bytecode cache so verification reads the new source.
        cache = f"/tmp/swe-wz-pycache-{time.time_ns()}"
        result = asyncio.run(
            self._env.deployment.runtime.run_in_session(
                BashAction(
                    command=(
                        f"export PYTHONPYCACHEPREFIX={cache}; "
                        f'export PYTHONPATH="$ROOT/src:$ROOT:${{PYTHONPATH:-}}"; {command}'
                    ),
                    timeout=self.verification_policy.test_timeout,
                    check="silent",
                )
            )
        )
        return result.output, result.exit_code

    def _record(self, record: dict, status: str) -> None:
        record["status"] = status
        self.verification_session.mkdir(parents=True, exist_ok=True)
        (self.verification_session / "verification.json").write_text(
            json.dumps(self.verifications, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        (self.verification_session / "state.json").write_text(
            json.dumps({"status": status, "repair_count": self.repair_count}, indent=2), encoding="utf-8"
        )
        self.info["verification"] = self.verifications

    def handle_submission(
        self, step: StepOutput, *, observation: str = "", force_submission: bool = False
    ) -> StepOutput:
        step = super().handle_submission(step, observation=observation, force_submission=force_submission)
        if force_submission and step.submission and hasattr(self, "verification_session"):
            review = review_submission(step.submission, self.verification_policy)
            if not review.findings:
                (self.verification_session / "candidate.patch").write_bytes(review.diff.encode("utf-8"))
            return step
        if not step.done or not step.submission:
            return step
        policy = self.verification_policy
        review = review_submission(step.submission, policy)
        started = time.monotonic()
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
            if all(finding.startswith("test_modified:") for finding in review.findings):
                if self.repair_count < policy.max_repairs:
                    self.repair_count += 1
                    self._record(record, "repair_requested")
                    feedback = "Submission rejected: existing test files were modified. "
                    feedback += "Revert those changes and submit again: " + ", ".join(review.findings)
                    return step.model_copy(
                        update={"done": False, "submission": None, "exit_status": None, "observation": feedback}
                    )
                self._record(record, "repair_exhausted")
                return step.model_copy(
                    update={"submission": None, "exit_status": "repair_exhausted", "observation": str(review.findings)}
                )
            self._record(record, "policy_rejected")
            return step.model_copy(
                update={"submission": None, "exit_status": "policy_rejected", "observation": str(review.findings)}
            )
        failures = []
        for command in policy.test_commands:
            output, returncode = self._run_test(command)
            category = classify_test(output, returncode)
            record["tests"].append(
                {"command": command, "category": category, "returncode": returncode, "output": output[-8000:]}
            )
            if category != "passed":
                failures.append(category)
                if category not in {"code_compile_failed", "unit_test_failed"}:
                    break
        assert self._env is not None
        self._env.communicate('cd "$ROOT" && git add -A && git diff --cached > /root/wz-after.patch')
        after = self._env.read_file("/root/wz-after.patch", encoding="utf-8")
        record["duration_ms"] = int((time.monotonic() - started) * 1000)
        if after != review.diff:
            self._record(record, "workspace_changed_during_tests")
            return step.model_copy(
                update={
                    "submission": None,
                    "exit_status": "workspace_changed_during_tests",
                    "observation": "Tests changed the patch",
                }
            )
        if failures:
            if any(category not in {"code_compile_failed", "unit_test_failed"} for category in failures):
                self._record(record, "verification_blocked")
                return step.model_copy(
                    update={
                        "submission": None,
                        "exit_status": "verification_blocked",
                        "observation": "Tests could not run",
                    }
                )
            if self.repair_count >= policy.max_repairs:
                self._record(record, "repair_exhausted")
                return step.model_copy(
                    update={
                        "submission": None,
                        "exit_status": "repair_exhausted",
                        "observation": "Repair limit reached",
                    }
                )
            self.repair_count += 1
            self._record(record, "repair_requested")
            feedback = "Submission rejected: tests failed. Continue repairing the current patch.\n"
            feedback += "\n".join(
                f"{test['command']}: {test['category']}\n{test['output']}" for test in record["tests"]
            )
            return step.model_copy(
                update={"done": False, "submission": None, "exit_status": None, "observation": feedback}
            )
        (self.verification_session / "candidate.patch").write_bytes(review.diff.encode("utf-8"))
        record["approved"] = self.approve_patch(review)
        if not record["approved"]:
            self._record(record, "approval_declined")
            return step.model_copy(
                update={"submission": None, "exit_status": "approval_declined", "observation": "Approval declined"}
            )
        self._env.communicate('cd "$ROOT" && git add -A && git diff --cached > /root/wz-final.patch')
        final = self._env.read_file("/root/wz-final.patch", encoding="utf-8")
        if final != review.diff:
            self._record(record, "workspace_changed_during_approval")
            return step.model_copy(
                update={
                    "submission": None,
                    "exit_status": "workspace_changed_during_approval",
                    "observation": "Patch changed during approval",
                }
            )
        (self.verification_session / "approved.patch").write_bytes(review.diff.encode("utf-8"))
        self._record(record, "Verified")
        return step.model_copy(update={"exit_status": "verified"})
