import hashlib
import json
import subprocess
import sys
from pathlib import Path
import numpy as np

from memory_intelligence.retrieval import lexical_rank, reciprocal_rank_fusion
from memory_intelligence.vector_index import VectorIndex


DOCUMENTS = [
    ("deploy-target", "Production releases require manual approval before deployment."),
    ("deploy-bridge", "An operator authorization gate protects each release approval workflow."),
    ("cache-target", "The application stores reusable responses to reduce repeated computation."),
    ("cache-bridge", "A memoization layer keeps cached results for faster repeated work."),
    ("database-target", "All schema changes run inside a transaction and roll back on failure."),
    ("database-bridge", "Atomic migration safety relies on transactional rollback guarantees."),
    ("logging-noise", "Structured logs include timestamps and request identifiers."),
    ("network-noise", "The proxy retries temporary network failures with bounded backoff."),
]


def records() -> list[dict[str, object]]:
    return [
        {
            "memoryId": memory_id,
            "content": content,
            "contentRevision": 1,
            "contentHash": hashlib.sha256(content.encode()).hexdigest(),
            "kind": "fact",
        }
        for memory_id, content in DOCUMENTS
    ]


def test_real_lsa_vectors_recall_a_target_without_query_term_overlap() -> None:
    query = "operator authorization gate"
    target = dict(DOCUMENTS)["deploy-target"].casefold()
    assert not any(term in target for term in query.split())
    assert "deploy-target" not in lexical_rank(query, DOCUMENTS, 5)
    index = VectorIndex()
    index.sync_snapshot("project", records())
    semantic = [item["memoryId"] for item in index.search("project", query, 5)]
    assert "deploy-target" in semantic


def test_reciprocal_rank_fusion_is_deterministic_and_deduplicated() -> None:
    fused = reciprocal_rank_fusion(["a", "b", "c"], ["b", "d", "a"], 4)
    assert fused == ["b", "a", "d", "c"]


def test_semantic_recall_survives_rotations_in_repeated_singular_values(monkeypatch) -> None:
    original = np.linalg.svd

    def rotated_svd(*args, **kwargs):
        left, singular, right = original(*args, **kwargs)
        # Rotate the degenerate unit-singular-value subspace, as LAPACK may do.
        indices = np.flatnonzero(np.isclose(singular, 1.0))
        if len(indices) > 1:
            a, b = indices[0], indices[-1]
            rotation = np.eye(len(singular))
            rotation[a, a] = rotation[b, b] = np.cos(0.71)
            rotation[a, b] = -np.sin(0.71)
            rotation[b, a] = np.sin(0.71)
            left = left @ rotation.T
            right = rotation @ right
        return left, singular, right

    monkeypatch.setattr(np.linalg, "svd", rotated_svd)
    index = VectorIndex()
    index.sync_snapshot("project", records())
    assert "deploy-target" in [item["memoryId"] for item in index.search("project", "operator authorization gate", 5)]


def test_offline_benchmark_reports_real_fts5_quality_latency_and_process_memory() -> None:
    script = Path(__file__).parents[1] / "evaluation" / "offline_benchmark.py"
    completed = subprocess.run([sys.executable, str(script)], check=True, capture_output=True, text=True, timeout=10)
    result = json.loads(completed.stdout)
    assert result["modes"]["lexical"]["recallAt3"] == 0.0
    assert result["modes"]["semantic"]["recallAt3"] == 1.0
    assert result["modes"]["hybrid"]["recallAt3"] == 1.0
    assert result["processPeakRssBytes"] > result["pythonTracemallocPeakBytes"] > 0
    assert result["buildMs"] > 0
