"""Repository isolation, retrieval hints and submission policy adapted from wzAgent."""

import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


def git(args: list[str], cwd: Path, *, env: dict | None = None) -> str:
    result = subprocess.run(
        ["git", "-c", f"safe.directory={cwd.resolve()}", *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"Git failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def is_test(path: str) -> bool:
    name = PurePosixPath(path).name.lower()
    return bool({"test", "tests"} & set(PurePosixPath(path.lower()).parts)) or bool(
        re.search(r"^test_|_test\.|\.(test|spec)\.", name)
    )


def protected_path(path: str) -> bool:
    normalized = path.replace("\\", "/").lower()
    name = PurePosixPath(normalized).name
    return (
        normalized.startswith("/")
        or ".." in PurePosixPath(normalized).parts
        or ":" in normalized
        or ".git" in PurePosixPath(normalized).parts
        or name == ".env"
        or name.startswith((".env.", "secrets.", "credentials."))
        or name
        in {"id_rsa", "id_ed25519", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "uv.lock"}
        or PurePosixPath(name).suffix in {".pem", ".key", ".crt"}
        or normalized.startswith((".github/workflows/", ".circleci/"))
        or name in {".gitlab-ci.yml", "jenkinsfile", "azure-pipelines.yml"}
    )


@dataclass
class PatchReview:
    diff: str
    files: list[str]
    added: int
    deleted: int
    findings: list[str]


@dataclass
class Repository:
    root: Path
    git_dir: Path
    base: str
    session: Path

    @classmethod
    def prepare(cls, source: Path, session: Path) -> "Repository":
        source, session = source.resolve(), session.resolve()
        if session == source or source in session.parents:
            raise ValueError("Session directory must be outside the source repository.")
        if session.exists():
            raise ValueError("Use a new session directory; existing sessions are never overwritten.")
        base = git(["rev-parse", "HEAD"], source).strip()
        session.mkdir(parents=True)
        git(
            [
                "clone",
                "--local",
                "--no-hardlinks",
                "--no-checkout",
                f"--separate-git-dir={session / 'control.git'}",
                "--",
                str(source),
                str(session / "repo"),
            ],
            source,
        )
        repository = cls(session / "repo", session / "control.git", base, session)
        repository.command(["checkout", "--detach", base])
        return repository

    def command(self, args: list[str], *, env: dict | None = None) -> str:
        return git([f"--git-dir={self.git_dir}", f"--work-tree={self.root}", *args], self.root, env=env)

    def tracked_files(self) -> list[str]:
        return self.command(["ls-tree", "-r", "--name-only", "-z", self.base]).rstrip("\0").split("\0")

    def context(self, task: str, limit: int = 8) -> list[dict]:
        keywords = set(re.findall(r"[a-zA-Z_][a-zA-Z0-9_-]{2,}", task.lower())) - {
            "the",
            "and",
            "for",
            "with",
            "this",
            "that",
            "from",
            "issue",
            "when",
            "should",
        }
        referenced = {name.lower() for name in re.findall(r"[\w.-]+\.(?:py|tsx?|jsx?|md|json|ya?ml|toml)", task)}
        candidates = []
        for path in self.tracked_files():
            target = self.root / path
            if protected_path(path) or target.is_symlink() or not target.is_file() or target.stat().st_size > 30_000:
                continue
            if self.root not in target.resolve().parents:
                continue
            data = target.read_bytes()
            if b"\0" in data:
                continue
            content = data.decode("utf-8", errors="replace")
            score = 12 * (PurePosixPath(path).name.lower() in referenced)
            score += sum(3 * (word in path.lower()) + (word in content.lower()) for word in keywords)
            if any(word in task.lower() for word in ("部署", "配置", "docker", "deploy", "configuration")):
                score += 8 * (
                    PurePosixPath(path).name.lower()
                    in {
                        "dockerfile",
                        "docker-compose.yml",
                        "config.py",
                        "settings.py",
                        "readme.md",
                        "pyproject.toml",
                    }
                )
            candidates.append({"path": path, "content": content[:6000], "score": score})
        source_stems = {
            PurePosixPath(item["path"]).stem
            for item in sorted(candidates, key=lambda item: -item["score"])[:limit]
            if item["score"] > 0 and not is_test(item["path"])
        }
        for item in candidates:
            stem = re.sub(r"^test_|_test$|\.(test|spec)$", "", PurePosixPath(item["path"]).stem)
            if is_test(item["path"]) and stem in source_stems:
                item["score"] += 8
        return sorted(candidates, key=lambda item: (-item["score"], item["path"]))[:limit]

    def review(self, max_files: int = 5, max_lines: int = 500) -> PatchReview:
        # A private index captures staged, unstaged and new files against the pinned baseline.
        env = os.environ | {"GIT_INDEX_FILE": str(self.session / "review.index")}
        self.command(["read-tree", self.base], env=env)
        self.command(["add", "-A", "--", "."], env=env)
        options = ["--cached", "--no-ext-diff", "--no-textconv", "--no-renames", self.base, "--"]
        diff = self.command(["diff", "--binary", *options], env=env)
        files = self.command(["diff", "--name-only", "-z", *options], env=env).rstrip("\0").split("\0") if diff else []
        stats = self.command(["diff", "--numstat", *options], env=env)
        added = deleted = 0
        findings = []
        if not diff:
            findings.append("empty_patch")
        for line in stats.splitlines():
            counts = line.split("\t", 2)
            if counts[0] == "-" or counts[1] == "-":
                findings.append("binary_patch")
            else:
                added += int(counts[0])
                deleted += int(counts[1])
        if len(files) > max_files or added + deleted > max_lines:
            findings.append("patch_size_exceeded")
        baseline = set(self.tracked_files())
        # Also detect newly created ignored secrets, which git add deliberately excludes.
        others = self.command(["ls-files", "--others", "-z"]).rstrip("\0").split("\0")
        for path in sorted(set(files + others)):
            if not path:
                continue
            target = self.root / path
            if protected_path(path):
                findings.append(f"protected_path:{path}")
            if path in files and (target.is_symlink() or self.root not in target.resolve().parents):
                findings.append(f"unsafe_path:{path}")
            if path in files and path in baseline and is_test(path):
                findings.append(f"existing_test_modified:{path}")
        if re.search(r"^(?:new|old) mode (?:120000|160000)|^new file mode (?:120000|160000)", diff, re.MULTILINE):
            findings.append("symlink_or_submodule_change")
        if re.search(
            r"^\+[^+].*(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|BEGIN .*PRIVATE KEY)", diff, re.MULTILINE
        ):
            findings.append("possible_secret")
        check = subprocess.run(
            ["git", f"--git-dir={self.git_dir}", f"--work-tree={self.root}", "diff", "--check", *options],
            cwd=self.root,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        if check.returncode:
            findings.append("diff_check_failed:" + check.stdout[-2000:])
        return PatchReview(diff, files, added, deleted, findings)
