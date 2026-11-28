"""Run from the candidate Requests checkout, with this file on Python's stdin."""

from pathlib import Path

import requests

if Path(requests.__file__).resolve().parent != Path.cwd() / "requests":
    raise RuntimeError("Expected to import requests from the candidate checkout")

headers = requests.Request("GET", "http://example.invalid/").prepare().headers
if "Content-Length" in headers:
    raise SystemExit(f"Empty GET unexpectedly includes Content-Length: {headers['Content-Length']}")
print("Empty GET omits Content-Length")
