from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .embedder import LocalLsaEmbedder
from .protocol import ProtocolError

MAX_RECORDS = 2_000
MAX_CONTENT_CHARACTERS = 8_000
MAX_TOP_K = 50


@dataclass(frozen=True)
class VectorRecord:
    memory_id: str
    content: str
    content_revision: int
    content_hash: str
    kind: str


class VectorIndex:
    def __init__(self, embedder: LocalLsaEmbedder | None = None) -> None:
        self.embedder = embedder or LocalLsaEmbedder()
        self.project_id: str | None = None
        self._records: dict[str, VectorRecord] = {}
        self._ordered: list[VectorRecord] = []
        self._vectors = None

    def sync_snapshot(self, project_id: str, values: object) -> dict[str, Any]:
        self._bind_project(project_id)
        records = validate_records(values)
        self._records = {record.memory_id: record for record in records}
        self._rebuild()
        return self.status()

    def upsert(self, project_id: str, values: object) -> dict[str, Any]:
        self._bind_project(project_id)
        records = validate_records(values)
        for record in records:
            self._records[record.memory_id] = record
        self._rebuild()
        return self.status()

    def remove(self, project_id: str, values: object) -> dict[str, Any]:
        self._bind_project(project_id)
        if not isinstance(values, list) or len(values) > MAX_RECORDS or not all(isinstance(value, str) for value in values):
            raise ProtocolError("invalid-records", "ids must be a bounded string array")
        for memory_id in values:
            self._records.pop(memory_id, None)
        self._rebuild()
        return self.status()

    def search(self, project_id: str, query: object, top_k: object) -> list[dict[str, Any]]:
        self._bind_project(project_id)
        if not isinstance(query, str) or not query.strip() or len(query) > 500:
            raise ProtocolError("invalid-query", "query must be a non-empty bounded string")
        if not isinstance(top_k, int) or isinstance(top_k, bool) or top_k < 1 or top_k > MAX_TOP_K:
            raise ProtocolError("invalid-top-k", "topK is outside the allowed range")
        if self._vectors is None or not self._ordered:
            return []
        query_vector = self.embedder.embed_query(query)
        if query_vector.size == 0:
            return []
        scores = self._vectors @ query_vector
        ranked = sorted(range(len(self._ordered)), key=lambda index: (-float(scores[index]), self._ordered[index].memory_id))
        results: list[dict[str, Any]] = []
        for index in ranked[:top_k]:
            score = float(scores[index])
            if score <= 0.0:
                continue
            record = self._ordered[index]
            results.append(
                {
                    "memoryId": record.memory_id,
                    "score": score,
                    "contentRevision": record.content_revision,
                    "contentHash": record.content_hash,
                }
            )
        return results

    def status(self) -> dict[str, Any]:
        state = self.embedder.state
        return {
            "projectId": self.project_id,
            "recordCount": len(self._records),
            "modelId": state.model_id,
            "dimensions": state.dimensions,
            "vocabularySize": state.vocabulary_size,
        }

    def _bind_project(self, project_id: str) -> None:
        if not isinstance(project_id, str) or not project_id or len(project_id) > 200:
            raise ProtocolError("invalid-project", "projectId is invalid")
        if self.project_id is None:
            self.project_id = project_id
        elif self.project_id != project_id:
            raise ProtocolError("project-mismatch", "worker is already bound to another project")

    def _rebuild(self) -> None:
        self._ordered = sorted(self._records.values(), key=lambda record: record.memory_id)
        self._vectors = self.embedder.fit(record.content for record in self._ordered)


def validate_records(values: object) -> list[VectorRecord]:
    if not isinstance(values, list) or len(values) > MAX_RECORDS:
        raise ProtocolError("invalid-records", "records must be a bounded array")
    records: list[VectorRecord] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, dict):
            raise ProtocolError("invalid-record", "record must be an object")
        if set(value) != {"memoryId", "content", "contentRevision", "contentHash", "kind"}:
            raise ProtocolError("invalid-record", "record fields are invalid")
        memory_id = value["memoryId"]
        content = value["content"]
        revision = value["contentRevision"]
        content_hash = value["contentHash"]
        kind = value["kind"]
        if not isinstance(memory_id, str) or not memory_id or len(memory_id) > 200 or memory_id in seen:
            raise ProtocolError("invalid-record", "memoryId is invalid or duplicated")
        if not isinstance(content, str) or not content.strip() or len(content) > MAX_CONTENT_CHARACTERS:
            raise ProtocolError("invalid-record", "content is invalid")
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            raise ProtocolError("invalid-record", "contentRevision is invalid")
        if not isinstance(content_hash, str) or len(content_hash) != 64:
            raise ProtocolError("invalid-record", "contentHash is invalid")
        if kind not in {"fact", "decision", "experience"}:
            raise ProtocolError("invalid-record", "kind is invalid")
        seen.add(memory_id)
        records.append(
            VectorRecord(
                memory_id=memory_id,
                content=content,
                content_revision=revision,
                content_hash=content_hash,
                kind=kind,
            )
        )
    return records
