"""Real Git and shell integration tests; deterministic upstream models, no API calls."""

import json
import shlex

import pytest

from minisweagent.agents.verified import VerificationPolicy, VerifiedAgent, classify_failure
from minisweagent.environments.wz import WzDockerEnvironment, docker_run_args
from minisweagent.models.test_models import DeterministicModel, make_output
from minisweagent.run.wz import create_demo_source, demo_outputs, issue_text, local_env, run_demo_case
from minisweagent.utils.wz_repository import Repository, git, protected_path


@pytest.fixture
def repository(tmp_path):
    return Repository.prepare(create_demo_source(tmp_path / "source", "blank_name"), tmp_path / "session")


def agent_for(repository, *, commands=None, approve=None, max_repairs=2, step_limit=10, test_timeout=30):
    return VerifiedAgent(
        DeterministicModel(outputs=demo_outputs("blank_name"), cost_per_call=0),
        local_env(repository.root),
        repository=repository,
        policy=VerificationPolicy(
            tuple(commands or ["python -m unittest -v"]), max_repairs=max_repairs, test_timeout=test_timeout
        ),
        approve=approve or (lambda review: True),
        system_template="Test",
        instance_template="{{task}}",
        step_limit=step_limit,
        cost_limit=1,
        output_path=repository.session / "trajectory.json",
    )


@pytest.mark.parametrize("name", ["blank_name", "inclusive_range", "absolute_value"])
def test_real_edit_test_feedback_and_source_isolation(tmp_path, name):
    summary = run_demo_case(tmp_path, name)
    assert summary["baseline_returncode"] != 0
    assert summary["exit_status"] == "Verified"
    assert summary["repairs"] == 1 and summary["model_calls"] == 4
    assert summary["source_unchanged"]
    assert summary["verification"][0]["status"] == "repair_requested"
    assert summary["verification"][0]["tests"][0]["category"] == "unit_test_failed"
    trace = json.loads((tmp_path / name / "session/trajectory.json").read_text(encoding="utf-8"))
    assert any("Submission rejected: tests failed" in str(message.get("content")) for message in trace["messages"])
    assert trace["verification"]["attempts"][-1]["approved"]
    assert (tmp_path / name / "session/approved.patch").is_file()


@pytest.mark.parametrize(
    ("command", "category"),
    [
        ("python -m missing_dependency_wz_123456", "dependency_missing"),
        ("missing_command_wz_123456", "command_missing"),
        ("python -c 'import sys; sys.exit(3)'", "unknown"),
        ("python -c 'import time; time.sleep(3)'", "timeout"),
    ],
)
def test_nonrepairable_failures_stop_without_spending_retries(repository, command, category):
    agent = agent_for(repository, commands=[command], test_timeout=1)
    assert agent.run("Fix")["exit_status"] == "VerificationBlocked"
    assert agent.repair_count == 0 and agent.n_calls == 2
    assert agent.verifications[0]["tests"][0]["category"] == category
    assert not (repository.session / "approved.patch").exists()


def test_retry_limit_and_model_budget_are_independent(repository):
    agent = agent_for(repository, max_repairs=0)
    assert agent.run("Fix")["exit_status"] == "RepairExhausted"
    assert agent.n_calls == 2 and agent.repair_count == 0


def test_repair_keeps_upstream_step_budget(repository):
    agent = agent_for(repository, step_limit=2)
    assert agent.run("Fix")["exit_status"] == "LimitsExceeded"
    assert agent.repair_count == 1 and agent.n_calls == 2
    assert len(agent.verifications) == 1


def test_repair_keeps_upstream_cost_budget(repository):
    agent = agent_for(repository)
    for output in agent.model.config.outputs:
        output["extra"]["cost"] = 0.6
    assert agent.run("Fix")["exit_status"] == "LimitsExceeded"
    assert agent.cost == pytest.approx(1.2)
    assert agent.repair_count == 1


def test_declining_final_review_exports_candidate_only(repository):
    agent = agent_for(repository, approve=lambda review: False)
    assert agent.run("Fix")["exit_status"] == "ApprovalDeclined"
    assert (repository.session / "candidate.patch").is_file()
    assert not (repository.session / "approved.patch").exists()


def test_edit_during_approval_invalidates_test_evidence(repository):
    def approve(review):
        (repository.root / "app.py").write_text("def f(value): return 42\n", encoding="utf-8")
        return True

    assert agent_for(repository, approve=approve).run("Fix")["exit_status"] == "WorkspaceChangedDuringApproval"
    assert not (repository.session / "approved.patch").exists()


def test_test_command_that_modifies_source_cannot_pass(repository):
    script = "from pathlib import Path; Path('app.py').write_text('changed by test\\n')"
    agent = agent_for(repository, commands=["python -c " + shlex.quote(script)])
    assert agent.run("Fix")["exit_status"] == "WorkspaceChangedDuringTests"
    assert not (repository.session / "candidate.patch").exists()


def test_policy_failure_runs_no_tests(repository):
    (repository.root / ".env").write_text("DEMO=value\n", encoding="utf-8")
    agent = agent_for(repository)
    assert agent.run("Fix")["exit_status"] == "PolicyRejected"
    assert not agent.verifications[0]["tests"]
    assert "protected_path:.env" in agent.verifications[0]["findings"]


def test_empty_submission_cannot_succeed(repository):
    agent = agent_for(repository)
    agent.model = DeterministicModel(
        outputs=[make_output("Done", [{"command": "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"}])]
    )
    assert agent.run("Fix")["exit_status"] == "PolicyRejected"
    assert agent.verifications[0]["findings"] == ["empty_patch"]


def test_patch_includes_staged_unstaged_and_new_files(repository):
    (repository.root / "app.py").write_text("def f(value): return value\n", encoding="utf-8")
    repository.command(["add", "app.py"])
    (repository.root / "app.py").write_text("def f(value): return abs(value)\n", encoding="utf-8")
    (repository.root / "new.py").write_text("answer = 42\n", encoding="utf-8")
    review = repository.review()
    assert set(review.files) == {"app.py", "new.py"}
    assert "+def f(value): return abs(value)" in review.diff
    assert not review.findings
    assert "patch_size_exceeded" in repository.review(max_files=1).findings
    assert "patch_size_exceeded" in repository.review(max_lines=1).findings


def test_deleted_tests_binary_and_ignored_secrets_are_rejected(repository):
    (repository.root / "test_app.py").unlink()
    (repository.root / "image.bin").write_bytes(b"\0\x01\x02")
    (repository.root / ".gitignore").write_text(".env*\n", encoding="utf-8")
    (repository.root / ".env.local").write_text("DEMO=value\n", encoding="utf-8")
    review = repository.review()
    assert "existing_test_modified:test_app.py" in review.findings
    assert "binary_patch" in review.findings
    assert "protected_path:.env.local" in review.findings


def test_context_associates_source_and_tests_without_reading_secrets(repository):
    hints = repository.context("修复 app.py 的 f 函数")
    paths = [item["path"] for item in hints]
    assert paths.index("app.py") < paths.index("test_app.py")
    assert "test_app.py" in paths
    assert all(not protected_path(path) for path in paths)


def test_dirty_source_uses_head_and_existing_session_is_refused(tmp_path):
    source = create_demo_source(tmp_path / "source", "blank_name")
    committed = (source / "app.py").read_text(encoding="utf-8")
    (source / "app.py").write_text("uncommitted work\n", encoding="utf-8")
    repository = Repository.prepare(source, tmp_path / "session")
    assert (repository.root / "app.py").read_text(encoding="utf-8") == committed
    assert (source / "app.py").read_text(encoding="utf-8") == "uncommitted work\n"
    assert repository.git_dir.is_dir() and (repository.root / ".git").is_file()
    with pytest.raises(ValueError, match="never overwritten"):
        Repository.prepare(source, tmp_path / "session")
    with pytest.raises(ValueError, match="outside"):
        Repository.prepare(source, source / "session")


@pytest.mark.parametrize("commands", [(), ("",), ("   ",)])
def test_no_test_commands_are_not_a_success(commands):
    with pytest.raises(ValueError, match="test command"):
        VerificationPolicy(commands)


@pytest.mark.parametrize("path", ["../x.py", "C:/x.py", ".git/config", ".github/workflows/ci.yml", ".env.production"])
def test_protected_paths(path):
    assert protected_path(path)


@pytest.mark.parametrize("url", ["https://example.org/x/y/issues/1", "https://github.com/x/y/pull/1", "file:///secret"])
def test_invalid_issue_urls_are_rejected_before_network(url):
    with pytest.raises(ValueError, match="Expected"):
        issue_text(url)


def test_failure_classifier_does_not_treat_generic_typeerror_as_compile_error():
    assert classify_failure({"returncode": 1, "output": "TypeError: dependency API changed"}) == "unknown"
    assert classify_failure({"returncode": 1, "output": "SyntaxError: invalid syntax"}) == "code_compile_failed"
    assert (
        classify_failure({"returncode": 1, "output": "FAILED: ModuleNotFoundError: no module named x"})
        == "dependency_missing"
    )


def test_zero_collected_tests_block_submission(repository):
    command = "python -c " + shlex.quote("import unittest; unittest.TextTestRunner().run(unittest.TestSuite())")
    agent = agent_for(repository, commands=[command])
    assert agent.run("Fix")["exit_status"] == "VerificationBlocked"
    assert agent.verifications[0]["tests"][0]["category"] == "no_tests_collected"


def test_hardened_docker_profile(repository):
    args = docker_run_args(repository.root)
    assert {"--network=none", "--read-only", "--cap-drop=ALL"} <= set(args)
    assert any(arg.startswith("--user=") and not arg.startswith("--user=0:") for arg in args)
    assert str(repository.git_dir) not in " ".join(args)
    assert "docker.sock" not in " ".join(args)


def test_local_tool_does_not_inherit_model_credentials(repository, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "private-api-key-test")
    monkeypatch.setenv("GITHUB_TOKEN", "private-github-token-test")
    output = local_env(repository.root).execute(
        {"command": 'python -c \'import os; print(os.getenv("OPENAI_API_KEY"), os.getenv("GITHUB_TOKEN"))\''}
    )
    assert output["returncode"] == 0
    assert "private-api-key-test" not in output["output"]
    assert "private-github-token-test" not in output["output"]


def test_docker_executes_in_workspace_when_available(repository, container_executable):
    env = WzDockerEnvironment(
        executable=container_executable,
        image="python:3.11-slim",
        cwd="/workspace",
        run_args=docker_run_args(repository.root),
        env={"HOME": "/tmp", "PYTHONDONTWRITEBYTECODE": "1"},
    )
    try:
        assert (
            env.execute({"command": "test -f app.py && echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"})["returncode"] == 0
        )
    finally:
        env.cleanup()


def test_repository_changes_do_not_depend_on_agent_git_index(repository):
    (repository.root / "app.py").write_text("def f(value): return value\n", encoding="utf-8")
    repository.command(["add", "."])
    repository.command(
        [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "Agent commit",
        ]
    )
    assert "+def f(value): return value" in repository.review().diff
    assert git(["status", "--porcelain"], repository.session.parent / "source") == ""
