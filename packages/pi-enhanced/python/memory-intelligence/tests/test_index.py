import hashlib

import pytest

from memory_intelligence import embedder
from memory_intelligence.embedder import EmbeddingUnavailable, LocalLsaEmbedder
from memory_intelligence.protocol import ProtocolError
from memory_intelligence.vector_index import VectorIndex


def record(memory_id: str, content: str, revision: int = 1) -> dict[str, object]:
    return {
        "memoryId": memory_id,
        "content": content,
        "contentRevision": revision,
        "contentHash": hashlib.sha256(content.encode()).hexdigest(),
        "kind": "fact",
    }


def test_sync_upsert_remove_and_project_isolation() -> None:
    index = VectorIndex()
    first = record("a", "manual approval protects production releases")
    second = record("b", "operator authorization gate for every release")
    assert index.sync_snapshot("project-a", [first, second])["recordCount"] == 2
    updated = record("a", "deployment checklist and rollback procedure", 2)
    assert index.upsert("project-a", [updated])["recordCount"] == 2
    assert index.remove("project-a", ["b"])["recordCount"] == 1
    with pytest.raises(ProtocolError, match="another project"):
        index.search("project-b", "deployment", 5)


def test_rejects_duplicates_and_invalid_versions() -> None:
    index = VectorIndex()
    duplicate = record("same", "first")
    with pytest.raises(ProtocolError, match="duplicated"):
        index.sync_snapshot("project", [duplicate, duplicate])
    invalid = {**record("bad", "content"), "contentRevision": 0}
    with pytest.raises(ProtocolError, match="contentRevision"):
        index.sync_snapshot("project", [invalid])


def test_reports_a_missing_local_embedding_dependency(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(embedder, "np", None)
    with pytest.raises(EmbeddingUnavailable, match="numpy"):
        LocalLsaEmbedder().ensure_available()
