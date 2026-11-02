import json

import pytest

from memory_intelligence.protocol import MAX_REQUEST_BYTES, ProtocolError, parse_request


def test_parses_a_bounded_request_and_preserves_request_id() -> None:
    request = parse_request(b'{"requestId":"r-1","op":"health","payload":{}}\n')
    assert request.request_id == "r-1"
    assert request.operation == "health"


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        (b"not-json", "invalid-json"),
        (b'{"requestId":"bad id","op":"health"}', "invalid-request-id"),
        (b'{"requestId":"r","op":"execute","payload":{}}', "unsupported-operation"),
        (b'{"requestId":"r","op":"health","payload":{},"script":"x"}', "invalid-request"),
    ],
)
def test_rejects_invalid_protocol_frames(raw: bytes, code: str) -> None:
    with pytest.raises(ProtocolError) as caught:
        parse_request(raw)
    assert caught.value.code == code


def test_rejects_an_oversized_frame_without_echoing_it() -> None:
    with pytest.raises(ProtocolError) as caught:
        parse_request(b"x" * (MAX_REQUEST_BYTES + 1))
    assert caught.value.code == "request-too-large"
    assert len(str(caught.value)) < 100


def test_input_is_one_json_object() -> None:
    raw = json.dumps({"requestId": "r", "op": "health", "payload": []}).encode()
    with pytest.raises(ProtocolError, match="payload"):
        parse_request(raw)
