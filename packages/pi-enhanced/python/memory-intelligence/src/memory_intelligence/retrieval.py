from __future__ import annotations

from collections.abc import Sequence


def reciprocal_rank_fusion(
    lexical_ids: Sequence[str], semantic_ids: Sequence[str], limit: int, rank_constant: int = 60
) -> list[str]:
    scores: dict[str, float] = {}
    for ranking in (lexical_ids, semantic_ids):
        for rank, memory_id in enumerate(ranking, start=1):
            scores[memory_id] = scores.get(memory_id, 0.0) + 1.0 / (rank_constant + rank)
    return sorted(scores, key=lambda memory_id: (-scores[memory_id], memory_id))[:limit]


def lexical_rank(query: str, documents: Sequence[tuple[str, str]], limit: int) -> list[str]:
    terms = {term for term in query.casefold().split() if term}
    scored: list[tuple[int, str]] = []
    for memory_id, content in documents:
        score = sum(1 for term in terms if term in content.casefold())
        if score:
            scored.append((score, memory_id))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [memory_id for _score, memory_id in scored[:limit]]
