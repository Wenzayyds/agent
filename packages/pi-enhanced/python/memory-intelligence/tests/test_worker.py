from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def test_jsonl_worker_lifecycle() -> None:
    process = subprocess.Popen(
        [sys.executable, "-m", "memory_intelligence.worker"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=Path(__file__).parents[1] / "src",
    )
    assert process.stdin is not None
    assert process.stdout is not None
    requests = [
        {"requestId": "health-1", "op": "health", "payload": {}},
        {
            "requestId": "sync-1",
            "op": "sync_snapshot",
            "payload": {
                "projectId": "project-a",
                "records": [
                    {
                        "memoryId": "bridge",
                        "content": "approval workflow connects operator authorization to release controls",
                        "contentRevision": 1,
                        "contentHash": "a" * 64,
                        "kind": "fact",
                    },
                    {
                        "memoryId": "target",
                        "content": "production deployment requires the release controls before publishing",
                        "contentRevision": 2,
                        "contentHash": "b" * 64,
                        "kind": "decision",
                    },
                ],
            },
        },
        {
            "requestId": "search-1",
            "op": "search_vectors",
            "payload": {"projectId": "project-a", "query": "operator authorization", "topK": 2},
        },
        {"requestId": "stop-1", "op": "shutdown", "payload": {}},
    ]
    process.stdin.write("".join(json.dumps(request) + "\n" for request in requests))
    process.stdin.flush()
    responses = [json.loads(process.stdout.readline()) for _ in requests]
    assert process.wait(timeout=5) == 0
    assert all(response["ok"] for response in responses)
    assert [response["requestId"] for response in responses] == [request["requestId"] for request in requests]
    assert responses[0]["result"]["modelId"] == "lsa-tfidf-svd-v1"
    assert responses[1]["result"]["recordCount"] == 2
    assert {item["memoryId"] for item in responses[2]["result"]["candidates"]} == {"bridge", "target"}
    assert all("content" not in item for item in responses[2]["result"]["candidates"])
