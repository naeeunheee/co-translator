# Co Translator Streaming Router Protocol

The router boundary is NDJSON so Go, Python, TypeScript, or another media worker can produce the same frame shape without sharing runtime code.

Each input line is one UTF-8 JSON object:

```json
{
  "session_id": "session-1",
  "source_language": "auto",
  "target_language": "ko",
  "captured_at_unix_ms": 1778496899152,
  "payload_b64": "AQID"
}
```

Fields:

- `session_id`: stable stream/session id.
- `source_language`: optional, local/router metadata only. OpenAI translation sessions still infer source language.
- `target_language`: optional if the router has a default target language.
- `captured_at_unix_ms`: capture timestamp used for end-to-end latency metrics.
- `payload_b64`: encoded audio frame payload. The router treats it as opaque bytes.

Routing rules:

- If `target_language` is empty, use the router default target language.
- If no route exists for the target, drop the frame and report a metric.
- Keep queues bounded. Dropping stale frames is better than growing latency.
- Router overhead must stay below 700 ms. The current benchmark budget is stricter: p95 below 1 ms.

The Go package exposes `ParseWireFrame` and `FormatWireFrame` for this contract. Other languages should match the same field names and base64 payload behavior exactly.
