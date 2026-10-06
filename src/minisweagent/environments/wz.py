"""Execution profiles for the verified workflow; submission is handled by its agent."""

import os
import shutil
import subprocess
from pathlib import Path

from minisweagent.environments.docker import DockerEnvironment
from minisweagent.environments.local import LocalEnvironment, _run

TOOL_ENV_KEYS = {
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "VIRTUAL_ENV",
    "PYTHONPATH",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
}


class DeferredSubmission:
    def _check_finished(self, output: dict) -> None:
        pass


class WzLocalEnvironment(DeferredSubmission, LocalEnvironment):
    """Trusted local execution. On Windows use Git Bash, not cmd or WSL."""

    def execute(self, action: dict, cwd: str = "", *, timeout: int | None = None) -> dict:
        command = action.get("command", "")
        if os.name == "nt":
            git_exe = shutil.which("git")
            bash = Path(git_exe).parent.parent / "bin" / "bash.exe" if git_exe else Path("")
            if not bash.is_file():
                raise RuntimeError("Git Bash is required for local execution on Windows.")
            command = subprocess.list2cmdline([str(bash), "-c", command])
        tool_env = {key: value for key, value in os.environ.items() if key.upper() in TOOL_ENV_KEYS}
        tool_env.update(self.config.env)
        try:
            result = _run(command, cwd or self.config.cwd or os.getcwd(), tool_env, timeout or self.config.timeout)
            return {"output": result.stdout, "returncode": result.returncode, "exception_info": ""}
        except Exception as exc:
            raw_output = getattr(exc, "output", None)
            if isinstance(raw_output, bytes):
                raw_output = raw_output.decode("utf-8", errors="replace")
            return {
                "output": raw_output or "",
                "returncode": -1,
                "exception_info": f"An error occurred while executing the command: {exc}",
                "extra": {"exception_type": type(exc).__name__, "exception": str(exc)},
            }


def docker_run_args(repo: Path) -> list[str]:
    user = f"{os.getuid()}:{os.getgid()}" if os.name == "posix" and os.getuid() else "65532:65532"
    return [
        "--rm",
        "--network=none",
        "--cpus=2",
        "--memory=2g",
        "--pids-limit=256",
        "--security-opt=no-new-privileges",
        "--cap-drop=ALL",
        f"--user={user}",
        "--read-only",
        "--tmpfs=/tmp:rw,noexec,nosuid,size=128m",
        "--mount",
        f"type=bind,source={repo.resolve()},target=/workspace",
    ]


class WzDockerEnvironment(DeferredSubmission, DockerEnvironment):
    def cleanup(self) -> None:
        if getattr(self, "container_id", None):
            subprocess.run([self.config.executable, "rm", "-f", self.container_id], capture_output=True, timeout=60)
            self.container_id = None
