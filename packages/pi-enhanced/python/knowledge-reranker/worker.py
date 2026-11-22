"""Offline MiniLM cross-encoder for authorized Knowledge chunks only."""
import hashlib
import json
import sys
from pathlib import Path


HASHES = {
    "config.json": "cc2cfe51aa3fd759d21d21acf5dfd6994aa67a3c9210636d22e143699d336c77",
    "model.safetensors": "5daeca2481a76b5976a2bdc32f0a78532b6716da4f8cd3ff59460ef8d2f359b4",
    "sentencepiece.bpe.model": "cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865",
    "special_tokens_map.json": "378eb3bf733eb16e65792d7e3fda5b8a4631387ca04d2015199c4d4f22ae554d",
    "tokenizer_config.json": "e7fbfbfa6347b4e414c1cee50d142e2c2f9a895dad68b068ae83a8b564c3837e",
    "tokenizer.json": "62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626",
}


def run():
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    root = Path("/models")
    for name, expected in HASHES.items():
        with (root / name).open("rb") as asset:
            if hashlib.file_digest(asset, "sha256").hexdigest() != expected:
                raise ValueError("Pinned model asset mismatch")
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    tokenizer = AutoTokenizer.from_pretrained(root, local_files_only=True, trust_remote_code=False)
    model = AutoModelForSequenceClassification.from_pretrained(
        root, local_files_only=True, trust_remote_code=False, use_safetensors=True
    ).eval()

    for line in sys.stdin:
        request = json.loads(line)
        op = request["op"]
        if op == "health":
            result = {"status": "ready"}
        elif op == "shutdown":
            result = {}
        elif op == "rerank_pairs":
            query = request["payload"]["query"]
            passages = request["payload"]["passages"]
            if not isinstance(query, str) or not 1 <= len(query) <= 500 or not 1 <= len(passages) <= 12:
                raise ValueError("Invalid reranker request")
            if any(not isinstance(text, str) or len(text) > 1400 for text in passages):
                raise ValueError("Invalid reranker passage")
            with torch.inference_mode():
                inputs = tokenizer(
                    [query] * len(passages), passages,
                    padding=True, truncation=True, max_length=256, return_tensors="pt",
                )
                scores = model(**inputs).logits.flatten().tolist()
            result = {"scores": scores}
        else:
            raise ValueError("Unsupported reranker operation")
        print(json.dumps({"requestId": request["requestId"], "ok": True, "result": result},
                         allow_nan=False), flush=True)
        if op == "shutdown":
            break


if __name__ == "__main__":
    run()
