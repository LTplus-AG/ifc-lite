---
"@ifc-lite/collab": minor
---

Continuing the plan. Lands the differential layer composer (v0.7), the
property unit converter (v1.0 / open problem #3), conflict resolver
actions on the UI bridge, the `FederationResolver` interface, and the
network-latency simulation perf harness (v0.2).

- `extractMinimalLayer(doc, baseline, opts)`: produces an IFCX layer
  containing only the entities and fields that changed since
  `baseline`. Entities created since baseline are emitted whole;
  entities that already existed only get their changed attributes /
  children / inherits keys. Toggle whether updated values count as
  diffs via `includeUpdatedValues`.

- `convertEntityUnits(doc, from, to)` walks every Pset and converts
  numeric `PropertyValue`s with a matching `unit`. Ships SI-relative
  scale tables for length (m/cm/mm/in/ft), area (m²/cm²/mm²/ft²/in²),
  volume (m³/cm³/mm³/L), and angle (rad/deg). `convertValue(value,
  from, to)` is exposed for one-shot conversions. `familyOf(unit)`
  classifies a unit string.

- Conflict UI bridge: `bridge.keepMine(key)` and `bridge.acceptTheirs(key)`
  run registered handlers (per `ConflictKind`) and close the bucket.
  Handlers receive `{ bucket }` and are responsible for emitting the
  follow-up CRDT edit.

- `FederationResolver` interface: typed `toGlobalId / fromGlobalId /
  getModelForGlobalId` contract. `passThroughResolver` is the default
  for IFCX UUID paths (globally unique by construction).
  `createMapBackedResolver(table)` covers explicit lookup tables. The
  renderer's existing numeric-offset `FederationRegistry` can be
  wrapped to satisfy the interface without forcing `@ifc-lite/collab`
  to depend on the renderer (adapter snippet documented in source).

- `createLatencyChannel(a, b, { baseMs, jitterMs, dropRate, random })`
  wraps a pair of Y.Docs with a queued, time-bucketed update channel.
  `flushUntil(t)` advances simulated time and dispatches due updates.
  Useful for benchmarking the §15 perf budget under simulated network
  conditions.

Tests added (+18, total 119 passing): minimal-layer round-trips and
diff-only behaviour, unit conversion across families plus skipping on
mismatched unit, bridge `keepMine` / `acceptTheirs` lifecycle including
follow-up CRDT writes from handlers, resolver pass-through and
map-backed lookups, latency channel arrival-time behaviour and
deterministic drop rate under a seeded PRNG.
