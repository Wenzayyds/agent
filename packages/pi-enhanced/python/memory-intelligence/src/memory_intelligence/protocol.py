from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

MAX_REQUEST_BYTES = 1024 * 1024
MAX_REQUEST_ID_LENGTH = 100
ALLOWED_OPERATIONS = frozenset(
    {
        "health",
        "encode_e5",
        "sync_snapshot",
        "upsert_vectors",
        "remove_vectors",
        "search_vectors",
        "shutdown",
    }
)
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]+$")


class ProtocolError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Request:
    request_id: str
    operation: str
    payload: dict[str, Any]


def parse_request(raw: bytes) -> Request:
    if len(raw) > MAX_REQUEST_BYTES:
        raise ProtocolError("request-too-large", "request exceeds the protocol size limit")
    try:
        decoded = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ProtocolError("invalid-encoding", "request must be UTF-8") from error
    try:
        value = json.loads(decoded)
    except json.JSONDecodeError as error:
        raise ProtocolError("invalid-json", "request must be one JSON object") from error
    if not isinstance(value, dict):
        raise ProtocolError("invalid-request", "request must be an object")
    if set(value) - {"requestId", "op", "payload"}:
        raise ProtocolError("invalid-request", "request contains unsupported fields")
    request_id = value.get("requestId")
    operation = value.get("op")
    payload = value.get("payload", {})
    if (
        not isinstance(request_id, str)
        or not request_id
        or len(request_id) > MAX_REQUEST_ID_LENGTH
        or _REQUEST_ID_PATTERN.fullmatch(request_id) is None
    ):
        raise ProtocolError("invalid-request-id", "requestId is invalid")
    if not isinstance(operation, str) or operation not in ALLOWED_OPERATIONS:
        raise ProtocolError("unsupported-operation", "operation is not supported")
    if not isinstance(payload, dict):
        raise ProtocolError("invalid-payload", "payload must be an object")
    return Request(request_id=request_id, operation=operation, payload=payload)


def success_frame(request_id: str, result: dict[str, Any]) -> str:
    return _frame({"requestId": request_id, "ok": True, "result": result})


def error_frame(request_id: str, code: str, message: str) -> str:
    return _frame({"requestId": request_id, "ok": False, "error": {"code": code, "message": message}})


def _frame(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
