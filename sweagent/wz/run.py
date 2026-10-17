"""Verified Issue repair on the full SWE-agent runtime.

Run with ``python -m sweagent.wz.run fix --help``.
"""

import json
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import litellm
import requests
import typer
import yaml
from dotenv import load_dotenv
from swerex.deployment.config import DockerDeploymentConfig

from sweagent.agent.agents import DefaultAgentConfig
from sweagent.agent.models import AbstractModel, InstanceStats
from sweagent.agent.problem_statement import TextProblemStatement
from sweagent.environment.repo import LocalRepoConfig
from sweagent.environment.swe_env import EnvironmentConfig, SWEEnv
from sweagent.wz.github import github_token, parse_issue, publish_draft, pull_request_status
from sweagent.wz.repository import PatchReview, Repository, git
from sweagent.wz.runs import prepare_run
from sweagent.wz.setup import EnvironmentPlan, prepare_image
from sweagent.wz.verification import VerificationPolicy, VerifiedSWEAgent

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env", override=False)
app = typer.Typer(help="Full SWE-agent with independent patch verification and human approval.")


def issue_text(url: str) -> str:
    owner, repo, number = parse_issue(url)
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "sweagent-wz"}
    if token := github_token():
        headers["Authorization"] = f"Bearer {token}"
    response = requests.get(f"https://api.github.com/repos/{owner}/{repo}/issues/{number}", headers=headers, timeout=30)
    response.raise_for_status()
    issue = response.json()
    return f"Source: {url}\n{issue['title']}\n\n{issue.get('body') or ''}"


def agent_config(model: str, context: list[dict], step_limit: int, cost_limit: float) -> DefaultAgentConfig:
    data = yaml.safe_load((ROOT / "config" / "default.yaml").read_text(encoding="utf-8"))["agent"]
    data["tools"]["bundles"] = [
        {"path": str(ROOT / "tools" / name)} for name in ("registry", "edit_anthropic", "submit")
    ]
    data["templates"]["instance_template"] += (
        "\nInitial repository hints (verify them before editing):\n{{context}}\n"
        "Submission runs independent tests and requires human approval. "
        "If tests fail, use their observation to repair the patch and submit again."
    )
    data["model"] = {
        "name": model,
        "per_instance_call_limit": step_limit,
        "per_instance_cost_limit": cost_limit,
        "api_base": os.getenv("OPENAI_API_BASE") or None,
    }
    prices = ROOT / "config" / "wz-model-prices.json"
    registered = json.loads(prices.read_text(encoding="utf-8"))
    if model in registered:
        data["model"]["litellm_model_registry"] = str(prices)
        litellm.register_model(registered)
    return DefaultAgentConfig.model_validate(data)


def approve_patch(review: PatchReview) -> bool:
    typer.echo(review.diff)
    return typer.confirm(
        f"测试已通过。批准补丁（{len(review.files)} 个文件，+{review.added}/-{review.deleted}）？", default=False
    )


def repair(
    source: Path,
    session: Path,
    task: str,
    model: str,
    test_commands: tuple[str, ...],
    image: str,
    prepare_env: bool,
    step_limit: int,
    cost_limit: float,
    approve=approve_patch,
    model_override: AbstractModel | None = None,
) -> dict:
    """Run one task in a copied Git repository; return the verified result."""
    repository = Repository.prepare(source, session)
    plan = EnvironmentPlan.detect(repository.root, test_commands)
    if prepare_env:
        image = prepare_image(repository, plan)
    context = repository.context(task)
    (session / "context.json").write_text(json.dumps(context, ensure_ascii=False, indent=2), encoding="utf-8")
    (session / "session.json").write_text(
        json.dumps(
            {
                "source": str(source.resolve()),
                "task": task,
                "model": model,
                "image": image,
                "test_commands": plan.test_commands,
                "base_commit": repository.base,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    statement = TextProblemStatement(
        id="repair", text=task, extra_fields={"context": json.dumps(context, ensure_ascii=False)}
    )
    env = SWEEnv.from_config(
        EnvironmentConfig(
            deployment=DockerDeploymentConfig(image=image, pull="missing"),
            repo=LocalRepoConfig(path=repository.root, base_commit=repository.base),
        )
    )
    agent = VerifiedSWEAgent.from_config(agent_config(model, context, step_limit, cost_limit))
    if model_override is not None:
        agent.model = model_override
    agent.configure_verification(VerificationPolicy(plan.test_commands), session, approve)
    try:
        env.start()
        result = agent.run(env=env, problem_statement=statement, output_dir=session / "trajectories")
    finally:
        env.close()
    status = result.info.get("exit_status")
    if status == "verified":
        patch = session / "approved.patch"
        repository.command(["apply", "--index", str(patch)])
    summary = {
        "status": status,
        "base_commit": repository.base,
        "session": str(session),
        "model_stats": result.info.get("model_stats", {}),
        "verifications": agent.verifications,
    }
    (session / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def continue_repair(
    session: Path,
    step_limit: int,
    cost_limit: float,
    approve=approve_patch,
    model_override: AbstractModel | None = None,
) -> dict:
    """Resume a budget-limited run from its saved history and candidate patch."""
    repository = Repository.open(session)
    saved = json.loads((session / "session.json").read_text(encoding="utf-8"))
    previous = json.loads((session / "summary.json").read_text(encoding="utf-8"))
    if previous["status"] not in {"submitted (exit_cost)", "exit_cost", "submitted (exit_total_execution_time)"}:
        msg = f"Cannot resume from {previous['status']}"
        raise ValueError(msg)
    if repository.base != saved["base_commit"]:
        msg = "Session base commit changed"
        raise ValueError(msg)
    candidate = session / "candidate.patch"
    if not candidate.is_file():
        msg = "No candidate patch to resume"
        raise ValueError(msg)
    trace = json.loads((session / "trajectories" / "repair.traj").read_text(encoding="utf-8"))
    context = json.loads((session / "context.json").read_text(encoding="utf-8"))
    env = SWEEnv.from_config(
        EnvironmentConfig(
            deployment=DockerDeploymentConfig(image=saved["image"], pull="missing"),
            repo=LocalRepoConfig(path=repository.root, base_commit=repository.base),
        )
    )
    agent = VerifiedSWEAgent.from_config(agent_config(saved["model"], context, step_limit, cost_limit))
    if model_override is not None:
        agent.model = model_override
    agent.configure_verification(VerificationPolicy(tuple(saved["test_commands"])), session, approve)
    verification_file = session / "verification.json"
    if verification_file.is_file():
        agent.verifications = json.loads(verification_file.read_text(encoding="utf-8"))
        agent.repair_count = sum(item.get("status") == "repair_requested" for item in agent.verifications)
    statement = TextProblemStatement(
        id="repair", text=saved["task"], extra_fields={"context": json.dumps(context, ensure_ascii=False)}
    )
    try:
        env.start()
        agent.setup(env=env, problem_statement=statement, output_dir=session / "trajectories")
        env.write_file("/root/wz-resume.patch", candidate.read_text(encoding="utf-8"))
        env.communicate('cd "$ROOT" && git apply /root/wz-resume.patch', check="raise")
        agent.history = trace["history"]
        agent._trajectory = trace["trajectory"]
        agent.info = trace["info"]
        if hasattr(agent.model, "stats"):
            agent.model.stats = InstanceStats.model_validate(trace["info"].get("model_stats", {}))
        agent._append_history(
            {
                "role": "user",
                "content": "Continue repairing the current patch, then submit it again.",
                "agent": agent.name,
                "message_type": "observation",
            }
        )
        while True:
            step = agent.step()
            agent.save_trajectory()
            if step.done:
                break
        result = agent.get_trajectory_data()
    finally:
        env.close()
    status = result["info"].get("exit_status")
    if status == "verified":
        repository.command(["apply", "--index", str(session / "approved.patch")])
    summary = {
        "status": status,
        "base_commit": repository.base,
        "session": str(session),
        "model_stats": result["info"].get("model_stats", {}),
        "verifications": agent.verifications,
    }
    (session / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


@app.command()
def fix(
    repo: Path = typer.Option(..., exists=True, file_okay=False, help="Local Git repository; source HEAD is copied."),
    task: str = typer.Option("", help="Task text; use this or --issue."),
    issue: str = typer.Option("", help="GitHub Issue URL."),
    model: str = typer.Option("", help="LiteLLM model name or MSWEA_MODEL_NAME."),
    test_command: list[str] = typer.Option([], "--test-command", help="Trusted test command; repeat if needed."),
    session: Path | None = typer.Option(None, help="New session folder outside the source repository."),
    image: str = typer.Option("python:3.11", help="Existing Docker image if --no-prepare-env."),
    prepare_env: bool = typer.Option(True, "--prepare-env/--no-prepare-env"),
    step_limit: int = typer.Option(60, min=1),
    cost_limit: float = typer.Option(3.0, min=0.01),
    publish_pr: bool = typer.Option(False, help="Publish an approved draft PR."),
    base_branch: str = typer.Option("", help="Base branch for draft PR."),
) -> None:
    if bool(task) == bool(issue):
        msg = "Provide exactly one of --task or --issue"
        raise typer.BadParameter(msg)
    if publish_pr and (not issue or not base_branch):
        msg = "--publish-pr requires --issue and --base-branch"
        raise typer.BadParameter(msg)
    model_name = model or os.getenv("MSWEA_MODEL_NAME") or os.getenv("MODEL_NAME", "")
    if not model_name:
        msg = "Set --model or MSWEA_MODEL_NAME"
        raise typer.BadParameter(msg)
    subprocess.run(["docker", "info"], capture_output=True, check=True, timeout=20)
    task_text = issue_text(issue) if issue else task
    session_path = (
        session
        or repo.resolve().parent / "swe-wz-runs" / (datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid4().hex[:6])
    ).resolve()
    typer.echo(f"源仓库：{repo.resolve()}\n任务副本：{session_path}\n模型：{model_name}\n任务：{task_text}")
    if not typer.confirm("允许模型在隔离副本中执行命令？", default=False):
        raise typer.Exit(1)
    summary = repair(
        repo,
        session_path,
        task_text,
        model_name,
        tuple(test_command),
        image,
        prepare_env,
        step_limit,
        cost_limit,
    )
    typer.echo(json.dumps(summary, ensure_ascii=False, indent=2))
    if summary["status"] != "verified":
        raise typer.Exit(1)
    if publish_pr:
        repository = Repository.open(session_path)
        typer.echo(
            json.dumps(
                publish_draft(repository, issue, base_branch, task_text.splitlines()[0]), ensure_ascii=False, indent=2
            )
        )


@app.command("pr-status")
def pr_status(issue: str = typer.Option(...), number: int = typer.Option(..., min=1)) -> None:
    typer.echo(json.dumps(pull_request_status(issue, number), ensure_ascii=False, indent=2))


@app.command("resume")
def resume_command(
    session: Path = typer.Option(..., exists=True, file_okay=False),
    step_limit: int = typer.Option(120, min=1),
    cost_limit: float = typer.Option(6.0, min=0.01),
) -> None:
    summary = continue_repair(session.resolve(), step_limit, cost_limit)
    typer.echo(json.dumps(summary, ensure_ascii=False, indent=2))
    if summary["status"] != "verified":
        raise typer.Exit(1)


@app.command()
def evaluate(
    manifest: Path = typer.Option(..., exists=True, dir_okay=False, help="JSON list of Issue or task cases."),
    output: Path = typer.Option(..., help="Directory for task sessions and results."),
    model: str = typer.Option(..., help="LiteLLM model name."),
    image: str = typer.Option("python:3.11"),
    prepare_env: bool = typer.Option(True, "--prepare-env/--no-prepare-env"),
    step_limit: int = typer.Option(30, min=1),
    cost_limit: float = typer.Option(0.25, min=0.01),
) -> None:
    """Record actual full-agent runs; no model success rate is inferred from scripted tests."""
    cases = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(cases, list) or not cases:
        msg = "Manifest must be a nonempty JSON array"
        raise typer.BadParameter(msg)
    identity = {
        "manifest": str(manifest.resolve()),
        "model": model,
        "cases": cases,
        "step_limit": step_limit,
        "cost_limit": cost_limit,
    }
    output.mkdir(parents=True, exist_ok=True)
    marker = output / "evaluation.json"
    if marker.exists():
        if json.loads(marker.read_text(encoding="utf-8")) != identity:
            msg = "Output belongs to a different evaluation"
            raise typer.BadParameter(msg)
    elif any(output.iterdir()):
        msg = "Use a new output directory"
        raise typer.BadParameter(msg)
    else:
        marker.write_text(json.dumps(identity, ensure_ascii=False, indent=2), encoding="utf-8")
    previous = (
        {item["case_id"]: item for item in json.loads((output / "results.json").read_text(encoding="utf-8"))}
        if (output / "results.json").exists()
        else {}
    )
    results = []
    for index, case in enumerate(cases, 1):
        if not isinstance(case, dict) or "repo" not in case or not (case.get("issue") or case.get("task")):
            msg = f"Invalid case {index}"
            raise typer.BadParameter(msg)
        case_id = re.sub(r"[^a-zA-Z0-9_-]", "-", str(case.get("id", index)))[:60]
        source = Path(case["repo"])
        if not source.is_absolute():
            source = manifest.parent / source
        source = source.resolve()
        if case.get("base_commit") and git(["rev-parse", "HEAD"], source).strip() != case["base_commit"]:
            msg = f"Case {case_id} has a different base commit"
            raise typer.BadParameter(msg)
        session = output / f"{index}-{case_id}"
        result = prepare_run(session, previous.get(case_id))
        if result is None:
            started = time.monotonic()
            summary = repair(
                source,
                session,
                issue_text(case["issue"]) if case.get("issue") else case["task"],
                model,
                tuple(case.get("test_commands", ())),
                image,
                prepare_env,
                step_limit,
                cost_limit,
                approve=lambda review: True,
            )
            result = {
                "case_id": case_id,
                "status": summary["status"],
                "success": summary["status"] == "verified",
                "model_stats": summary["model_stats"],
                "verifications": summary["verifications"],
                "duration_seconds": round(time.monotonic() - started, 2),
                "session": str(session),
            }
        results.append(result)
        (output / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        typer.echo(f"{case_id}: {result['status']}")


if __name__ == "__main__":
    app()
