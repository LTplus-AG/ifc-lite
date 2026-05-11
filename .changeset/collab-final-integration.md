---
"@ifc-lite/collab": minor
"@ifc-lite/collab-server": minor
---

Final integration batch. Closes the last cross-cutting items in the
plan: the spec §16.3 mutations bridge, open problem #7 (per-section
locks), the viewer-mount one-liner, the TLS bundle helper, and a
runnable performance benchmark suite. **+11 tests, total 175 passing.**

`@ifc-lite/collab`
- **`bindMutationsToCollab(view, session, opts)`** (spec §16.3): wraps
  `@ifc-lite/mutations` `MutablePropertyView` so legacy STEP property
  edits mirror to the Y.Doc whenever a collab session is bound. The
  view's existing observers / change-set tracking still fire; reads
  pass through. `resolveEntity(id)` translates numeric expressIds to
  IFCX paths; returning `null` skips the mirror for that mutation.
  `PROPERTY_TYPE_NAMES` maps `PropertyValueType` enum values to the
  IFCX type strings stored on `PropertyValue`.
- **`mountPresenceInViewer({ session, container, viewport })`** (spec
  §7 viewer mount): one-line glue that creates a presence overlay,
  forwards `mousemove → setCursor2d`, and returns a `teardown()`.
- **`runPerfBenchmarks(budget?)`** (§15): self-contained Node-runnable
  benchmarks measuring single-attribute update size, cold-load time
  for a 1k-entity fixture, and (gated by `COLLAB_BENCH_HEAVY`) state-
  vector size at 100k entities. Each result reports
  `{ name, value, unit, budget, ok }`. Useful for `vitest` perf
  regression coverage and CI smoke tests.

`@ifc-lite/collab-server`
- **Per-section locks (open #7).** `createPathLockRegistry()` →
  `add({ prefix, label?, exemptUserIds?, exemptRoles? })` /
  `remove(lock)` / `matches(path, principal)` / `clear()`.
  `verifyAgainstPathLocks(registry)` returns a `VerifyMessageFn`
  that decodes incoming sync-update frames, runs them through a
  throwaway Y.Doc to harvest touched paths, and rejects writes that
  intersect any locked prefix (audit reason `locked:<label>`).
  `harvestUpdatePaths(update)` is exposed for tests + custom
  filtering. Path format: `entities/wall`, `geometry/g7`, etc.
- **`startSecureCollabServer(opts)`**: bundles `createSecureHttpServer`
  + `secureHttpHandler` + `startCollabServer` so deployers get
  TLS-in-process plus the OWASP-baseline header wrapper without
  writing the wiring.

Tests added (+11): mutations bridge happy path / null-resolve / delete
mirror, path-lock registry add/match/remove + path harvesting + raw-WS
rejection of writes to a locked prefix, perf benchmarks for
single-attr-update / cold-load / runPerfBenchmarks happy paths,
secure-bundle smoke test (rejects missing cert paths), viewer-bridge
overlay mounting + mousemove forwarding + clean teardown via a
hand-rolled DOM stub.

Plan doc: v0.1 ☑ (mutations bridge added), v0.2 ☑ (mount-in-viewer
shipped), v0.5 ☑ (TLS bundle + per-section locks). Open problems are
closed in this batch as follows: problem #7 (per-section locks) is
new in this PR; problems #1, #2, #3, #4, #5, #6, #8, #9, #10 were
already closed in prior batches.
