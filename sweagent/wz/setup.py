"""Prepare dependency images from the pinned repository copy."""

import hashlib
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from sweagent.wz.repository import Repository, protected_path


@dataclass(frozen=True)
class EnvironmentPlan:
    languages: tuple[str, ...]
    test_commands: tuple[str, ...]

    @classmethod
    def detect(cls, root: Path, test_commands: tuple[str, ...] = ()) -> "EnvironmentPlan":
        python = any((root / name).exists() for name in ("pyproject.toml", "requirements.txt", "setup.py"))
        python = python or any(root.glob("*.py")) or (root / "src").is_dir()
        node = (root / "package.json").is_file()
        commands = []
        if python and ((root / "tests").exists() or any(root.glob("test_*.py"))):
            commands.append("python -m pytest -q")
        if node and "test" in json.loads((root / "package.json").read_text(encoding="utf-8")).get("scripts", {}):
            commands.append("npm test")
        if test_commands:
            commands = list(test_commands)
        if not commands:
            msg = "Cannot identify tests; pass --test-command explicitly"
            raise ValueError(msg)
        return cls(tuple(name for name, enabled in (("python", python), ("node", node)) if enabled), tuple(commands))


def prepare_image(repository: Repository, plan: EnvironmentPlan) -> str:
    """Build a reusable image; network is used only during dependency installation."""
    digest = hashlib.sha256(("setup-v3" + repository.base + repr(plan.languages)).encode()).hexdigest()[:16]
    image = f"swe-wz-deps:{digest}"
    if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode == 0:
        return image
    context = repository.session / "build-context"
    context.mkdir(exist_ok=True)
    for path in repository.tracked_files():
        source = repository.root / path
        if (
            protected_path(path)
            or source.is_symlink()
            or not source.is_file()
            or repository.root not in source.resolve().parents
        ):
            continue
        target = context / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    if "python" in plan.languages:
        lines = [
            "FROM python:3.11-slim",
            "ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple",
            "RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep "
            "&& rm -rf /var/lib/apt/lists/*",
        ]
        if "node" in plan.languages:
            lines.append(
                "RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm "
                "&& rm -rf /var/lib/apt/lists/*"
            )
    else:
        lines = [
            "FROM node:20-bookworm-slim",
            "RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep "
            "&& rm -rf /var/lib/apt/lists/*",
        ]
    lines += ["WORKDIR /opt/project", "COPY . ."]
    if "python" in plan.languages:
        if (context / "requirements.txt").exists():
            lines.append("RUN python -m pip install --no-cache-dir -r requirements.txt pytest")
        elif (context / "pyproject.toml").exists() or (context / "setup.py").exists():
            lines.append("RUN python -m pip install --no-cache-dir . pytest")
        else:
            lines.append("RUN python -m pip install --no-cache-dir pytest")
        lines.append("ENV PYTHONPATH=/workspace:/workspace/src")
    if "node" in plan.languages:
        if not (context / "package-lock.json").exists():
            msg = "Node dependency setup requires package-lock.json"
            raise ValueError(msg)
        lines.append("RUN npm ci --ignore-scripts")
        lines += ["ENV NODE_PATH=/opt/project/node_modules", "ENV PATH=/opt/project/node_modules/.bin:$PATH"]
    (context / "Dockerfile.wz").write_text("\n".join(lines) + "\n", encoding="utf-8")
    subprocess.run(["docker", "build", "-f", "Dockerfile.wz", "-t", image, "."], cwd=context, check=True)
    return image
