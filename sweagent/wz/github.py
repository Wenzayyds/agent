"""Publish an approved session as a draft pull request."""

import json
import os
import re
import subprocess
from dataclasses import dataclass
from uuid import uuid4

import requests

from sweagent.wz.repository import Repository


def parse_issue(url: str) -> tuple[str, str, int]:
    match = re.fullmatch(r"https://github\.com/([\w.-]+)/([\w.-]+)/issues/(\d+)/?", url)
    if not match:
        msg = "Expected https://github.com/OWNER/REPO/issues/NUMBER"
        raise ValueError(msg)
    return match.group(1), match.group(2), int(match.group(3))


def github_token() -> str:
    if token := os.getenv("GITHUB_TOKEN", ""):
        return token
    credential = subprocess.run(
        ["git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        capture_output=True,
        text=True,
        timeout=15,
        env=os.environ | {"GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"},
    )
    if credential.returncode:
        return ""
    return dict(line.split("=", 1) for line in credential.stdout.splitlines() if "=" in line).get("password", "")


@dataclass
class GitHubClient:
    token: str

    @classmethod
    def from_env(cls) -> "GitHubClient":
        token = github_token()
        if not token:
            msg = "Set GITHUB_TOKEN or configure Git credential manager"
            raise ValueError(msg)
        return cls(token)

    def request(self, method: str, path: str, **kwargs) -> dict | list:
        response = requests.request(
            method,
            "https://api.github.com" + path,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "mini-swe-agent-wz",
            },
            timeout=30,
            **kwargs,
        )
        response.raise_for_status()
        return response.json()


def publish_draft(repository: Repository, issue_url: str, base_branch: str, title: str) -> dict:
    owner, name, number = parse_issue(issue_url)
    api = GitHubClient.from_env()
    prefix = f"/repos/{owner}/{name}"
    remote_base = api.request("GET", f"{prefix}/branches/{base_branch}")["commit"]["sha"]
    if remote_base != repository.base:
        msg = "Source HEAD differs from remote base branch; refresh before publishing"
        raise ValueError(msg)
    state = repository.session / "state.json"
    if not state.exists() or json.loads(state.read_text(encoding="utf-8"))["status"] != "Verified":
        msg = "Only an approved, verified session may be published"
        raise ValueError(msg)
    branch, commit = commit_approved(repository, number)
    repository.command(["remote", "add", "delivery", f"https://github.com/{owner}/{name}.git"])
    push_branch(repository, branch, api.token)
    pr = api.request(
        "POST",
        f"{prefix}/pulls",
        json={
            "title": title[:250],
            "head": branch,
            "base": base_branch,
            "draft": True,
            "body": (
                f"Closes #{number}\n\nGenerated from a human-approved, independently tested repair session.\n"
                f"Base: `{repository.base}`.\nSession commit: `{commit}`."
            ),
        },
    )
    result = {"url": pr["html_url"], "number": pr["number"], "branch": branch, "commit": commit}
    (repository.session / "pull_request.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def commit_approved(repository: Repository, issue_number: int) -> tuple[str, str]:
    state = repository.session / "state.json"
    if not state.exists() or json.loads(state.read_text(encoding="utf-8"))["status"] != "Verified":
        msg = "Only an approved, verified session may be committed"
        raise ValueError(msg)
    branch = f"wz/issue-{issue_number}-{repository.base[:7]}-{uuid4().hex[:6]}"
    repository.command(["switch", "-c", branch])
    repository.command(["add", "-A", "--", "."])
    repository.command(
        [
            "-c",
            "user.name=mini-SWE-agent-wz",
            "-c",
            "user.email=agent@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            f"fix: resolve issue #{issue_number}",
        ]
    )
    return branch, repository.command(["rev-parse", "HEAD"]).strip()


def push_branch(repository: Repository, branch: str, token: str) -> None:
    """Use Git's askpass protocol without putting the token in the URL or arguments."""
    askpass = repository.session / ("github-askpass.cmd" if os.name == "nt" else "github-askpass.sh")
    if os.name == "nt":
        askpass.write_text(
            "@echo off\necho %1 | findstr /i Username >nul\n"
            "if %errorlevel%==0 (echo x-access-token) else (echo %GITHUB_TOKEN%)\n",
            encoding="utf-8",
        )
    else:
        askpass.write_text(
            '#!/bin/sh\ncase "$1" in *Username*) printf x-access-token;; *) printf %s "$GITHUB_TOKEN";; esac\n',
            encoding="utf-8",
        )
        askpass.chmod(0o700)
    try:
        repository.command(
            ["-c", "credential.helper=", "push", "delivery", f"HEAD:refs/heads/{branch}"],
            env=os.environ | {"GITHUB_TOKEN": token, "GIT_ASKPASS": str(askpass), "GIT_TERMINAL_PROMPT": "0"},
        )
    finally:
        askpass.unlink(missing_ok=True)


def pull_request_status(issue_url: str, number: int) -> dict:
    owner, name, _ = parse_issue(issue_url)
    api = GitHubClient.from_env()
    prefix = f"/repos/{owner}/{name}"
    pr = api.request("GET", f"{prefix}/pulls/{number}")
    sha = pr["head"]["sha"]
    checks = api.request("GET", f"{prefix}/commits/{sha}/check-runs")["check_runs"]
    commit_status = api.request("GET", f"{prefix}/commits/{sha}/status")["state"]
    reviews = api.request("GET", f"{prefix}/pulls/{number}/reviews")
    return {
        "url": pr["html_url"],
        "state": pr["state"],
        "draft": pr["draft"],
        "commit_status": commit_status,
        "checks": [
            {"name": item["name"], "status": item["status"], "conclusion": item["conclusion"]} for item in checks
        ],
        "reviews": [{"user": item["user"]["login"], "state": item["state"]} for item in reviews],
    }
