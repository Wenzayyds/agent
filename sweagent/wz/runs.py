"""Reuse completed batch runs and restart incomplete ones, like SWE-agent."""

import json
from pathlib import Path
from uuid import uuid4


def completed_trajectory(session: Path) -> bool:
    path = session / "summary.json"
    if not path.is_file():
        return False
    try:
        status = json.loads(path.read_text(encoding="utf-8")).get("status")
    except (OSError, ValueError, KeyError, TypeError):
        return False
    return status not in (None, "early_exit")


def prepare_run(session: Path, previous: dict | None) -> dict | None:
    if previous is not None and completed_trajectory(session):
        return previous
    if session.exists():
        session.rename(session.with_name(f"{session.name}.incomplete-{uuid4().hex[:8]}"))
    return None
