from __future__ import annotations

import math
import os
from typing import Any

from .embedder import EmbeddingUnavailable
from .protocol import ProtocolError

E5_MODEL_ID = "intfloat/multilingual-e5-small"
E5_MODEL_REVISION = "614241f622f53c4eeff9890bdc4f31cfecc418b3"
E5_DIMENSIONS = 384
MAX_BATCH = 32


class E5Embedder:
    """CPU encoder for one pinned, locally provisioned model."""

    def __init__(self, cache_folder: str | None = None) -> None:
        self._cache_folder = cache_folder
        self._model: Any = None

    @staticmethod
    def identity() -> dict[str, str | int]:
        return {"id": E5_MODEL_ID, "revision": E5_MODEL_REVISION, "dimensions": E5_DIMENSIONS}

    def encode(self, texts: Any, purpose: Any) -> list[list[float]]:
        if purpose not in ("query", "passage"):
            raise ProtocolError("invalid-payload", "Embedding purpose must be query or passage")
        if not isinstance(texts, list) or not 1 <= len(texts) <= MAX_BATCH or any(
            not isinstance(text, str) or not text.strip() or len(text) > 8000 or "\0" in text
            for text in texts
        ):
            raise ProtocolError("invalid-payload", "Embedding batch is invalid")
        if self._model is None:
            self._model = self._load()
        values = self._model.encode(
            [f"{purpose}: {text}" for text in texts],
            batch_size=min(16, len(texts)),
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
            prompt="",
        ).tolist()
        if len(values) != len(texts) or any(
            len(vector) != E5_DIMENSIONS or not all(math.isfinite(value) for value in vector)
            or not math.isclose(math.sqrt(sum(value * value for value in vector)), 1, abs_tol=1e-4)
            for vector in values
        ):
            raise EmbeddingUnavailable("E5 returned an invalid embedding")
        return values

    def _load(self) -> Any:
        # Force the hub offline even when this class is used outside the host worker.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        try:
            import torch
            from sentence_transformers import SentenceTransformer

            torch.set_num_threads(min(4, os.cpu_count() or 1))
            model = SentenceTransformer(
                E5_MODEL_ID,
                revision=E5_MODEL_REVISION,
                device="cpu",
                local_files_only=True,
                trust_remote_code=False,
                cache_folder=self._cache_folder,
                model_kwargs={"use_safetensors": True},
            )
            if model.get_sentence_embedding_dimension() != E5_DIMENSIONS:
                raise EmbeddingUnavailable("Unexpected E5 embedding dimension")
            model.max_seq_length = 512
            return model
        except (ImportError, OSError, ValueError, RuntimeError) as error:
            raise EmbeddingUnavailable("Pinned E5 model or CPU dependency is unavailable") from error
