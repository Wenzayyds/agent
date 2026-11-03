from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Iterable

try:
    import numpy as np
except ModuleNotFoundError:
    np = None  # type: ignore[assignment]

MODEL_ID = "lsa-tfidf-svd-v1"
_WORD_PATTERN = re.compile(r"[^\W_]+", re.UNICODE)
_CJK_PATTERN = re.compile(r"[\u3400-\u9fff]+")
_STOP_WORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "in",
        "is",
        "it",
        "of",
        "on",
        "or",
        "that",
        "the",
        "this",
        "to",
        "with",
    }
)


class EmbeddingUnavailable(Exception):
    pass


@dataclass(frozen=True)
class EmbeddingState:
    model_id: str
    dimensions: int
    vocabulary_size: int
    document_count: int


class LocalLsaEmbedder:
    """Corpus-local TF-IDF + truncated SVD embedding with no network dependency."""

    def __init__(self, maximum_dimensions: int = 64) -> None:
        self.maximum_dimensions = maximum_dimensions
        self._vocabulary: dict[str, int] = {}
        self._idf = None
        self._projection = None
        self._document_vectors = None

    def ensure_available(self) -> None:
        if np is None:
            raise EmbeddingUnavailable("numpy is not installed")

    def fit(self, documents: Iterable[str]) -> "np.ndarray":
        self.ensure_available()
        texts = list(documents)
        tokenized = [tokenize(text) for text in texts]
        vocabulary = sorted({token for tokens in tokenized for token in tokens})
        self._vocabulary = {token: index for index, token in enumerate(vocabulary)}
        if not texts or not vocabulary:
            self._idf = np.zeros((len(vocabulary),), dtype=np.float32)
            self._projection = np.zeros((len(vocabulary), 0), dtype=np.float32)
            self._document_vectors = np.zeros((len(texts), 0), dtype=np.float32)
            return self._document_vectors

        matrix = np.zeros((len(texts), len(vocabulary)), dtype=np.float64)
        document_frequency = np.zeros((len(vocabulary),), dtype=np.float64)
        for row, tokens in enumerate(tokenized):
            counts = Counter(tokens)
            for token, count in counts.items():
                column = self._vocabulary[token]
                matrix[row, column] = 1.0 + math.log(count)
                document_frequency[column] += 1.0
        self._idf = (np.log((1.0 + len(texts)) / (1.0 + document_frequency)) + 1.0).astype(np.float32)
        matrix *= self._idf
        matrix = _normalize_rows(matrix)

        if len(texts) == 1:
            self._projection = np.eye(len(vocabulary), dtype=np.float32)
            self._document_vectors = matrix.astype(np.float32)
            return self._document_vectors

        maximum_rank = min(len(texts) - 1, len(vocabulary))
        dimensions = min(
            self.maximum_dimensions,
            maximum_rank,
            max(2, int(math.sqrt(len(vocabulary)))),
        )
        _left, singular, right = np.linalg.svd(matrix, full_matrices=False)
        # Cutting a repeated singular-value block selects an arbitrary subspace
        # across LAPACK implementations. Keep only complete leading blocks.
        requested_dimensions = dimensions
        while 0 < dimensions < len(singular) and np.isclose(
            singular[dimensions - 1], singular[dimensions], rtol=1e-7, atol=1e-10
        ):
            dimensions -= 1
        if dimensions == 0:
            dimensions = requested_dimensions
            while dimensions < len(singular) and np.isclose(
                singular[dimensions - 1], singular[dimensions], rtol=1e-7, atol=1e-10
            ):
                dimensions += 1
        self._projection = right[:dimensions].T.astype(np.float32)
        self._document_vectors = _normalize_rows(matrix @ self._projection).astype(np.float32)
        return self._document_vectors

    def embed_query(self, query: str) -> "np.ndarray":
        self.ensure_available()
        if self._idf is None or self._projection is None:
            raise EmbeddingUnavailable("embedding model has not been fitted")
        vector = np.zeros((len(self._vocabulary),), dtype=np.float64)
        for token, count in Counter(tokenize(query)).items():
            column = self._vocabulary.get(token)
            if column is not None:
                vector[column] = (1.0 + math.log(count)) * float(self._idf[column])
        projected = vector @ self._projection
        norm = float(np.linalg.norm(projected))
        if norm > 0.0:
            projected = projected / norm
        return projected.astype(np.float32)

    @property
    def state(self) -> EmbeddingState:
        dimensions = 0 if self._document_vectors is None else int(self._document_vectors.shape[1])
        documents = 0 if self._document_vectors is None else int(self._document_vectors.shape[0])
        return EmbeddingState(
            model_id=MODEL_ID,
            dimensions=dimensions,
            vocabulary_size=len(self._vocabulary),
            document_count=documents,
        )


def tokenize(text: str) -> list[str]:
    normalized = text.casefold()
    tokens = [token for token in _WORD_PATTERN.findall(normalized) if token not in _STOP_WORDS]
    for sequence in _CJK_PATTERN.findall(normalized):
        tokens.extend(sequence)
        tokens.extend(sequence[index : index + 2] for index in range(len(sequence) - 1))
    return tokens


def _normalize_rows(matrix: "np.ndarray") -> "np.ndarray":
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0.0] = 1.0
    return matrix / norms
