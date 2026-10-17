"""Real Git and SWE-ReX checks for the verified full-agent extension."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import litellm
import pytest
from swerex.deployment.config import DockerDeploymentConfig

from sweagent.agent.models import PredeterminedTestModel
from sweagent.agent.problem_statement import TextProblemStatement
from sweagent.environment.repo import LocalRepoConfig
from sweagent.environment.swe_env import EnvironmentConfig, SWEEnv
from sweagent.types import StepOutput
from sweagent.wz.repository import Repository
from sweagent.wz.run import agent_config, continue_repair, repair
from sweagent.wz.runs import prepare_run
from sweagent.wz.setup import EnvironmentPlan
from sweagent.wz.verification import VerificationPolicy, VerifiedSWEAgent, review_submission


@pytest.fixture
def source(tmp_path):
    root = tmp_path / "source"
    root.mkdir()
    (root / "app.py").write_bytes(b"def f(x):\n    return 0\n")
    (root / "test_app.py").write_bytes(
        b"import unittest\nfrom app import f\n\nclass TestApp(unittest.TestCase):\n"
        b"    def test_value(self):\n        self.assertEqual(f(2), 2)\n"
    )
    (root / ".gitignore").write_text("__pycache__/\n.pytest_cache/\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline"],
        cwd=root,
        check=True,
    )
    return root


def test_repository_copy_context_and_patch_policy(source, tmp_path):
    repository = Repository.prepare(source, tmp_path / "session")
    assert repository.git_dir == repository.root / ".git"
    assert repository.command(["remote", "get-url", "origin"]).strip() == "."
    assert (repository.root / "app.py").read_text() == (source / "app.py").read_text()
    assert any(item["path"] == "app.py" for item in repository.context("Fix app.py function f"))
    (repository.root / "app.py").write_bytes(b"def f(x):\n    return x\n")
    review = repository.review()
    assert review.files == ["app.py"] and not review.findings
    assert not review_submission(review.diff, VerificationPolicy(("python -m unittest",))).findings
    (repository.root / "test_app.py").write_text("broken\n", encoding="utf-8")
    review = repository.review()
    assert "existing_test_modified:test_app.py" in review.findings
    assert (
        "test_modified:test_app.py"
        in review_submission(review.diff, VerificationPolicy(("python -m unittest",))).findings
    )
    assert (source / "app.py").read_text() == "def f(x):\n    return 0\n"


def test_upstream_config_accepts_extension(source, tmp_path):
    repository = Repository.prepare(source, tmp_path / "session")
    config = agent_config("gpt-4o", repository.context("Fix app.py"), 8, 2.0)
    assert config.model.per_instance_call_limit == 8
    assert [bundle.path.name for bundle in config.tools.bundles] == ["registry", "edit_anthropic", "submit"]
    assert isinstance(VerifiedSWEAgent.from_config(config), VerifiedSWEAgent)
    assert EnvironmentPlan.detect(source).test_commands == ("python -m pytest -q",)


def test_deepseek_alias_has_bounded_cost_config():
    model = "openai/deepseek-v4-flash"
    config = agent_config(model, [], 8, 0.25)
    assert Path(config.model.litellm_model_registry).is_file()
    assert litellm.supports_function_calling(model=model)
    response = litellm.ModelResponse(
        model="deepseek-flash",
        choices=[{"index": 0, "message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}],
        usage={"prompt_tokens": 1000, "completion_tokens": 100, "total_tokens": 1100},
    )
    assert litellm.completion_cost(completion_response=response, model=model) > 0


def test_batch_run_reuses_complete_and_archives_incomplete(tmp_path):
    session = tmp_path / "case"
    session.mkdir()
    (session / "summary.json").write_text('{"status":"verified"}', encoding="utf-8")
    previous = {"case_id": "case", "status": "verified"}
    assert prepare_run(session, previous) == previous
    (session / "summary.json").write_text("broken", encoding="utf-8")
    assert prepare_run(session, previous) is None
    assert not session.exists()
    assert len(list(tmp_path.glob("case.incomplete-*"))) == 1


def test_swerex_submission_feedback_and_approval(source, tmp_path):
    if not shutil.which("docker") or subprocess.run(["docker", "info"], capture_output=True).returncode:
        pytest.skip("Docker unavailable")
    image = os.getenv("SWE_WZ_TEST_IMAGE", "python:3.11")
    if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode:
        pytest.skip("Local Python image unavailable")
    (source / "src").mkdir()
    (source / "src" / "priority.py").write_bytes(b"marker = 42\n")
    subprocess.run(["git", "add", "-A"], cwd=source, check=True)
    subprocess.run(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "src module"],
        cwd=source,
        check=True,
    )
    repository = Repository.prepare(source, tmp_path / "session")
    env = SWEEnv.from_config(
        EnvironmentConfig(
            deployment=DockerDeploymentConfig(image=image, pull="never"),
            repo=LocalRepoConfig(path=repository.root, base_commit=repository.base),
        )
    )
    agent = VerifiedSWEAgent.from_config(agent_config("gpt-4o", [], 10, 1.0))
    agent.configure_verification(
        VerificationPolicy(("python -m unittest -v", 'python -c "import priority; assert priority.marker == 42"')),
        repository.session,
        lambda review: True,
    )
    try:
        env.start()
        agent._env = env
        env.communicate(
            'cd "$ROOT" && sed -i "s/return 0/return 1/" app.py && '
            'echo "# changed" >> test_app.py && git add -A && git diff --cached > /root/model.patch'
        )
        policy_feedback = agent.handle_submission(StepOutput(observation="<<SWE_AGENT_SUBMISSION>>"))
        assert not policy_feedback.done and "Revert" in policy_feedback.observation
        env.communicate(
            'cd "$ROOT" && git checkout HEAD -- test_app.py && git add -A && git diff --cached > /root/model.patch'
        )
        first = agent.handle_submission(StepOutput(observation="<<SWE_AGENT_SUBMISSION>>"))
        assert not first.done and "tests failed" in first.observation
        env.communicate(
            'cd "$ROOT" && sed -i "s/return 1/return x/" app.py && git add -A && git diff --cached > /root/model.patch'
        )
        second = agent.handle_submission(StepOutput(observation="<<SWE_AGENT_SUBMISSION>>"))
        assert second.done and second.exit_status == "verified" and second.submission
        assert [test["category"] for test in agent.verifications[-1]["tests"]] == ["passed", "passed"]
        assert json.loads((repository.session / "state.json").read_text())["status"] == "Verified"
        assert (repository.session / "approved.patch").exists()
    finally:
        env.close()


def test_full_agent_loop_uses_verified_submission(source, tmp_path):
    if not shutil.which("docker") or subprocess.run(["docker", "info"], capture_output=True).returncode:
        pytest.skip("Docker unavailable")
    image = os.getenv("SWE_WZ_TEST_IMAGE", "python:3.11")
    if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode:
        pytest.skip("Local Python image unavailable")
    repository = Repository.prepare(source, tmp_path / "session")
    env = SWEEnv.from_config(
        EnvironmentConfig(
            deployment=DockerDeploymentConfig(image=image, pull="never"),
            repo=LocalRepoConfig(path=repository.root, base_commit=repository.base),
        )
    )
    agent = VerifiedSWEAgent.from_config(agent_config("gpt-4o", [], 10, 1.0))
    agent.model = PredeterminedTestModel(
        [
            {
                "message": "",
                "tool_calls": [
                    {
                        "type": "function",
                        "id": "edit",
                        "function": {
                            "name": "bash",
                            "arguments": json.dumps({"command": 'sed -i "s/return 0/return x/" app.py'}),
                        },
                    }
                ],
            },
            {
                "message": "",
                "tool_calls": [{"type": "function", "id": "done", "function": {"name": "submit", "arguments": "{}"}}],
            },
        ]
    )
    agent.configure_verification(
        VerificationPolicy(("python -m unittest -v",)), repository.session, lambda review: True
    )
    try:
        env.start()
        result = agent.run(
            env=env,
            problem_statement=TextProblemStatement(id="repair", text="Fix f"),
            output_dir=repository.session / "trajectories",
        )
        assert result.info["exit_status"] == "verified"
        assert len(result.trajectory) == 2
        assert (repository.session / "approved.patch").exists()
    finally:
        env.close()


def test_repair_entrypoint_preserves_source_and_exports_approved_patch(source, tmp_path):
    if not shutil.which("docker") or subprocess.run(["docker", "info"], capture_output=True).returncode:
        pytest.skip("Docker unavailable")
    image = os.getenv("SWE_WZ_TEST_IMAGE", "python:3.11")
    if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode:
        pytest.skip("Local Python image unavailable")
    responses = PredeterminedTestModel(
        [
            {
                "message": "",
                "tool_calls": [
                    {
                        "type": "function",
                        "id": "edit",
                        "function": {
                            "name": "bash",
                            "arguments": json.dumps({"command": 'sed -i "s/return 0/return x/" app.py'}),
                        },
                    }
                ],
            },
            {
                "message": "",
                "tool_calls": [{"type": "function", "id": "done", "function": {"name": "submit", "arguments": "{}"}}],
            },
        ]
    )
    session = tmp_path / "session"
    result = repair(
        source,
        session,
        "Fix app.py",
        "gpt-4o",
        ("python -m unittest -v",),
        image,
        False,
        10,
        1.0,
        approve=lambda review: True,
        model_override=responses,
    )
    assert result["status"] == "verified"
    assert "return x" in (session / "repo" / "app.py").read_text()
    assert "return 0" in (source / "app.py").read_text()
    assert (session / "approved.patch").is_file()


def test_resume_after_cost_limit(source, tmp_path):
    if not shutil.which("docker") or subprocess.run(["docker", "info"], capture_output=True).returncode:
        pytest.skip("Docker unavailable")
    image = os.getenv("SWE_WZ_TEST_IMAGE", "python:3.11")
    if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode:
        pytest.skip("Local Python image unavailable")
    edit = {
        "message": "",
        "tool_calls": [
            {
                "type": "function",
                "id": "edit",
                "function": {
                    "name": "bash",
                    "arguments": json.dumps({"command": 'sed -i "s/return 0/return x/" app.py'}),
                },
            }
        ],
    }
    submit = {
        "message": "",
        "tool_calls": [{"type": "function", "id": "done", "function": {"name": "submit", "arguments": "{}"}}],
    }
    session = tmp_path / "session"
    first = repair(
        source,
        session,
        "Fix app.py",
        "gpt-4o",
        ("python -m unittest -v",),
        image,
        False,
        10,
        1.0,
        approve=lambda review: True,
        model_override=PredeterminedTestModel([edit, "raise_cost"]),
    )
    assert first["status"] == "submitted (exit_cost)"
    assert (session / "candidate.patch").is_file()
    resumed = continue_repair(
        session, 20, 2.0, approve=lambda review: True, model_override=PredeterminedTestModel([submit])
    )
    assert resumed["status"] == "verified"
    assert "return x" in (session / "repo" / "app.py").read_text()
    assert "return 0" in (source / "app.py").read_text()
