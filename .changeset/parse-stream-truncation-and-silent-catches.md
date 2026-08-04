---
"@ifc-lite/server-client": patch
"@ifc-lite/extensions": patch
"@ifc-lite/collab-server": patch
"@ifc-lite/sdk": patch
---

Stop `IfcServerClient.parseStream()` reporting a truncated stream as a successful parse, and log four failures that were previously invisible.

**Behaviour change (`@ifc-lite/server-client`):** `parseStream()` now throws `Stream ended without a complete event` when the SSE stream finishes without a `complete` or `error` event. Previously, a connection that dropped mid-parse — or a final frame truncated mid-JSON, whose `JSON.parse` failure was swallowed by a bare `catch {}` — ended the async generator normally, so `for await (const event of client.parseStream(file))` simply exited and the caller saw a successful parse that had produced only part of the model. The sibling `parseStreamToParquet()` already enforced this contract (`Stream ended without complete event`); the two paths now agree. Consumers that `break` out of the loop early are unaffected: an early return does not run the check.

Two further `parseStream()` fixes: a malformed SSE frame is now reported via `console.warn` instead of being dropped silently, and `yield` has been moved out of the `try` that wraps `JSON.parse`, so an error thrown into the generator by the consumer propagates instead of being swallowed as if it were a bad frame.

New warnings elsewhere, no behaviour change:

- `@ifc-lite/extensions` — an `AuditLog` subscriber that throws now warns once per listener (latched, so a persistently broken subscriber cannot log once per audited action). Delivery to the other listeners is unchanged.
- `@ifc-lite/collab-server` — the layer-registry auto-merge path warns when it skips because the pushed layer cannot be read, when a ref layer cannot be read during the idempotency probe, and when a merge attempt throws. Auto-merge failures are still contained and still never fail the push that triggered them; they are just no longer invisible to the operator.
- `@ifc-lite/sdk` — `bsdd` warns when the paginated `classProperties` fallback fails. The partial result is still returned, but it is also cached, so one transient failure otherwise answered every later call for that URI until the entry expired.
