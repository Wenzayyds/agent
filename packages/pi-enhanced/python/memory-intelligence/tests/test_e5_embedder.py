from __future__ import annotations

from typing import Any

import pytest

from memory_intelligence.e5_embedder import E5_DIMENSIONS, E5Embedder, EmbeddingUnavailable
from memory_intelligence.protocol import ProtocolError


def test_batches_prefixes_and_reuses_the_model(monkeypatch: pytest.MonkeyPatch) -> None:
    encoder = E5Embedder()
    calls: list[list[str]] = []
    loads: list[bool] = []

    class Model:
        def encode(self, passages: list[str], **kwargs: Any) -> Model:
            assert kwargs["normalize_embeddings"] is True
            assert kwargs["batch_size"] == len(passages)
            calls.append(passages)
            return self

        def tolist(self) -> list[list[float]]:
            return [[1.0, *([0.0] * (E5_DIMENSIONS - 1))] for _ in calls[-1]]

    def load() -> Model:
        loads.append(True)
        return Model()

    monkeypatch.setattr(encoder, "_load", load)
    assert len(encoder.encode(["one", "two"], "passage")) == 2
    assert len(encoder.encode(["other"], "query")) == 1
    assert calls == [["passage: one", "passage: two"], ["query: other"]]
    assert loads == [True]


def test_rejects_bad_batch_before_loading(monkeypatch: pytest.MonkeyPatch) -> None:
    encoder = E5Embedder()

    def load() -> None:
        raise AssertionError("validation must precede model loading")

    monkeypatch.setattr(encoder, "_load", load)
    for texts, purpose in [([], "query"), (["x"], "document"), (["x"] * 33, "passage"), (["  "], "query")]:
        with pytest.raises(ProtocolError):
            encoder.encode(texts, purpose)


def test_failed_load_can_be_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    encoder = E5Embedder()
    failures: list[bool] = []

    def load() -> None:
        failures.append(True)
        raise EmbeddingUnavailable("fixture")

    monkeypatch.setattr(encoder, "_load", load)
    for _ in range(2):
        with pytest.raises(EmbeddingUnavailable):
            encoder.encode(["x"], "query")
    assert failures == [True, True]
