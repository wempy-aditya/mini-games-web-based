#!/usr/bin/env python3
"""
Mock Jev / System One server for verifying Sentinel's LLM client.

    python3 games/sentinel/test/mock_llm_server.py [port]

Speaks the real System One wire shape (POST /v1/systemone) plus the OpenAI
chat shape, so the browser client can be exercised without spending a token or
holding a real key. Also serves a /v1/models listing like the real API.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8799


def systemone_answers(payload):
    """Answer whatever questions were asked, in the real typed shape."""
    answers = {}
    for key, spec in (payload.get("questions") or {}).items():
        kind = spec.get("type")
        if kind == "noul":
            answers[key] = {"type": "noul", "noul": 1.0, "confidence": 0.99}
        elif kind == "choice":
            # Pick the first criterion, so the test can predict the outcome.
            crit = spec.get("criteria") or {}
            first = next(iter(crit), "unknown")
            probs = {k: (0.8 if k == first else 0.2 / max(1, len(crit) - 1))
                     for k in crit}
            answers[key] = {
                "type": "choice",
                "choice": first,
                "confidence": 0.8,
                "probabilities": probs,
            }
        elif kind == "score":
            crit = spec.get("criteria") or []
            answers[key] = {
                "type": "score",
                "score": 1,
                "confidence": 0.75,
                "legend": {str(i): c for i, c in enumerate(crit)},
                "probabilities": {str(i): (1.0 if i == 1 else 0.0)
                                  for i in range(len(crit))},
            }
    return answers


class Handler(BaseHTTPRequestHandler):
    # The base class names this parameter `format`; renaming it trips Pyright's
    # incompatible-override check even though the call sites are identical.
    def log_message(self, format, *args):  # noqa: A002
        sys.stderr.write("[mock] " + format % args + "\n")

    def _send(self, code, body, ctype="application/json"):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        # The real API is a different origin from the game, so it sends CORS
        # headers. The mock must too, otherwise the browser client fails for a
        # reason that has nothing to do with the client itself.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            self._send(200, {
                "data": [
                    {"id": "jev-latest", "object": "model",
                     "owned_by": "typesafe"},
                    {"id": "jev-1.13.0", "object": "model",
                     "owned_by": "typesafe"},
                ]
            })
            return
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"

        if not (self.headers.get("Authorization") or "").startswith("Bearer "):
            self._send(401, {"error": {"message": "missing bearer token"}})
            return

        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError as exc:
            self._send(400, {"error": {"message": f"bad json: {exc}"}})
            return

        if "stream" in payload:
            self._send(400, {"error": {"message": "streaming is not supported"}})
            return

        if self.path.rstrip("/").endswith("/systemone"):
            self._send(200, {
                "model": payload.get("model", "jev-latest"),
                "answers": systemone_answers(payload),
                "escalate": False,
                "usage": {"input_tokens": 120, "output_tokens": 40},
            })
            return

        if self.path.rstrip("/").endswith("/chat/completions"):
            self._send(200, {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "model": payload.get("model", "mock"),
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": '{"difficulty":"aggressive","focus":"brute"}',
                    },
                    "finish_reason": "stop",
                }],
                "usage": {"prompt_tokens": 90, "completion_tokens": 20},
            })
            return

        self._send(404, {"error": {"message": f"no route for {self.path}"}})


if __name__ == "__main__":
    print(f"[mock] System One + OpenAI mock on http://127.0.0.1:{PORT}", flush=True)
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
