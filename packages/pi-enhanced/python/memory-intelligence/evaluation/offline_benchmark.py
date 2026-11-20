from __future__ import annotations

import json
import sqlite3
import statistics
import sys
import time
import tracemalloc
import ctypes
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from memory_intelligence.retrieval import reciprocal_rank_fusion
from memory_intelligence.vector_index import VectorIndex

CORPUS = [
    ("auth-bridge", "operator authorization approval workflow connects to release controls"),
    ("auth-target", "production deployment requires release controls before publishing"),
    ("cache-bridge", "fast response lookup acceleration is provided by a cache layer"),
    ("cache-target", "redis cache layer uses a bounded expiration policy"),
    ("branch-bridge", "alternate history navigation uses session branch selection"),
    ("branch-target", "session branch selection is represented by the active leaf manager"),
    ("secret-bridge", "credential protection masking is implemented by secret redaction"),
    ("secret-target", "secret redaction is applied by the token output sanitizer"),
    ("failure-bridge", "graceful recovery during an outage uses automatic fallback storage"),
    ("failure-target", "fallback storage is the local SQLite FTS5 index"),
    ("noise-logging", "structured logs keep bounded diagnostic categories"),
    ("noise-testing", "integration tests exercise deterministic lifecycle transitions"),
]

QUERIES = [
    ("operator authorization", "auth-target"),
    ("fast response lookup", "cache-target"),
    ("alternate history navigation", "branch-target"),
    ("credential protection masking", "secret-target"),
    ("graceful recovery outage", "failure-target"),
]


class Fts5Baseline:
    def __init__(self) -> None:
        self.database = sqlite3.connect(":memory:")
        self.database.execute("CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, content)")
        self.database.executemany("INSERT INTO memory_fts(memory_id, content) VALUES (?, ?)", CORPUS)

    def search(self, query: str, limit: int) -> list[str]:
        expression = " AND ".join(f'"{token.replace(chr(34), chr(34) * 2)}"' for token in query.split())
        rows = self.database.execute(
            "SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?",
            (expression, limit),
        ).fetchall()
        return [row[0] for row in rows]

    def close(self) -> None:
        self.database.close()


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * fraction)))
    return ordered[index]


def metrics(rankings: list[list[str]]) -> dict[str, float]:
    reciprocal_ranks: list[float] = []
    recalled = 0
    for ranking, (_query, expected) in zip(rankings, QUERIES, strict=True):
        if expected in ranking[:3]:
            recalled += 1
            reciprocal_ranks.append(1.0 / (ranking.index(expected) + 1))
        else:
            reciprocal_ranks.append(0.0)
    return {
        "recallAt3": recalled / len(QUERIES),
        "mrrAt3": sum(reciprocal_ranks) / len(reciprocal_ranks),
    }


def process_peak_rss_bytes() -> int:
    if sys.platform == "win32":
        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("page_fault_count", ctypes.c_ulong),
                ("peak_working_set_size", ctypes.c_size_t),
                ("working_set_size", ctypes.c_size_t),
                ("quota_peak_paged_pool_usage", ctypes.c_size_t),
                ("quota_paged_pool_usage", ctypes.c_size_t),
                ("quota_peak_non_paged_pool_usage", ctypes.c_size_t),
                ("quota_non_paged_pool_usage", ctypes.c_size_t),
                ("pagefile_usage", ctypes.c_size_t),
                ("peak_pagefile_usage", ctypes.c_size_t),
            ]

        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(counters)
        get_current_process = ctypes.windll.kernel32.GetCurrentProcess
        get_process_memory_info = ctypes.windll.psapi.GetProcessMemoryInfo
        get_current_process.restype = ctypes.c_void_p
        get_process_memory_info.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ProcessMemoryCounters),
            ctypes.c_ulong,
        ]
        get_process_memory_info.restype = ctypes.c_int
        if not get_process_memory_info(get_current_process(), ctypes.byref(counters), counters.cb):
            raise OSError("GetProcessMemoryInfo failed")
        return int(counters.peak_working_set_size)

    import resource

    maximum_rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(maximum_rss if sys.platform == "darwin" else maximum_rss * 1024)


def run() -> dict[str, object]:
    tracemalloc.start()
    index = VectorIndex()
    fts5 = Fts5Baseline()
    records = [
        {
            "memoryId": memory_id,
            "content": content,
            "contentRevision": 1,
            "contentHash": f"{position:064x}",
            "kind": "fact",
        }
        for position, (memory_id, content) in enumerate(CORPUS, start=1)
    ]
    started = time.perf_counter()
    index.sync_snapshot("offline-evaluation", records)
    build_ms = (time.perf_counter() - started) * 1_000

    rankings: dict[str, list[list[str]]] = {"lexical": [], "semantic": [], "hybrid": []}
    latencies: dict[str, list[float]] = {"lexical": [], "semantic": [], "hybrid": []}
    for _iteration in range(25):
        for query, _expected in QUERIES:
            started = time.perf_counter()
            lexical = fts5.search(query, 3)
            latencies["lexical"].append((time.perf_counter() - started) * 1_000)

            started = time.perf_counter()
            semantic = [item["memoryId"] for item in index.search("offline-evaluation", query, 3)]
            latencies["semantic"].append((time.perf_counter() - started) * 1_000)

            started = time.perf_counter()
            hybrid_lexical = fts5.search(query, 3)
            hybrid_semantic = [item["memoryId"] for item in index.search("offline-evaluation", query, 3)]
            hybrid = reciprocal_rank_fusion(hybrid_lexical, hybrid_semantic, 3)
            latencies["hybrid"].append((time.perf_counter() - started) * 1_000)

            if _iteration == 0:
                rankings["lexical"].append(lexical)
                rankings["semantic"].append(semantic)
                rankings["hybrid"].append(hybrid)
    _current, traced_peak = tracemalloc.get_traced_memory()
    process_peak = process_peak_rss_bytes()
    tracemalloc.stop()
    fts5.close()
    results: dict[str, object] = {
        "fixture": {"documents": len(CORPUS), "queries": len(QUERIES), "topK": 3, "iterations": 25},
        "modelId": index.status()["modelId"],
        "buildMs": round(build_ms, 4),
        "pythonTracemallocPeakBytes": traced_peak,
        "processPeakRssBytes": process_peak,
        "modes": {},
    }
    mode_results = results["modes"]
    assert isinstance(mode_results, dict)
    for mode in ("lexical", "semantic", "hybrid"):
        mode_results[mode] = {
            **metrics(rankings[mode]),
            "latencyP50Ms": round(statistics.median(latencies[mode]), 4),
            "latencyP95Ms": round(percentile(latencies[mode], 0.95), 4),
        }
    return results


if __name__ == "__main__":
    print(json.dumps(run(), indent=2, sort_keys=True))
