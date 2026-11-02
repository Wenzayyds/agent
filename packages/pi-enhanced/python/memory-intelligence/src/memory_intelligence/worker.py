from __future__ import annotations

import sys
from typing import Any

from .embedder import EmbeddingUnavailable, MODEL_ID
from .protocol import ProtocolError, Request, error_frame, parse_request, success_frame
from .vector_index import VectorIndex


def handle_request(index: VectorIndex, request: Request) -> tuple[dict[str, Any], bool]:
    payload = request.payload
    operation = request.operation
    if operation == "health":
        index.embedder.ensure_available()
        return {"status": "ready", "modelId": MODEL_ID, **index.status()}, False
    if operation == "sync_snapshot":
        return index.sync_snapshot(required_string(payload, "projectId"), payload.get("records")), False
    if operation == "upsert_vectors":
        return index.upsert(required_string(payload, "projectId"), payload.get("records")), False
    if operation == "remove_vectors":
        return index.remove(required_string(payload, "projectId"), payload.get("ids")), False
    if operation == "search_vectors":
        candidates = index.search(
            required_string(payload, "projectId"),
            payload.get("query"),
            payload.get("topK"),
        )
        return {"candidates": candidates, **index.status()}, False
    if operation == "shutdown":
        return {"status": "stopped"}, True
    raise ProtocolError("unsupported-operation", "operation is not supported")


def required_string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str):
        raise ProtocolError("invalid-payload", f"{key} must be a string")
    return value


def main() -> int:
    index = VectorIndex()
    for raw in sys.stdin.buffer:
        request_id = "invalid"
        try:
            request = parse_request(raw)
            request_id = request.request_id
            result, should_stop = handle_request(index, request)
            frame = success_frame(request_id, result)
        except ProtocolError as error:
            frame = error_frame(request_id, error.code, str(error))
            should_stop = False
        except EmbeddingUnavailable:
            frame = error_frame(request_id, "model-not-installed", "local embedding dependency is unavailable")
            should_stop = False
        except Exception:
            frame = error_frame(request_id, "worker-error", "memory intelligence operation failed")
            should_stop = False
        sys.stdout.write(frame + "\n")
        sys.stdout.flush()
        if should_stop:
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
