---
"@ifc-lite/collab": minor
"@ifc-lite/collab-server": minor
---

Tackle-everything batch. Closes the remaining substantial items in the
plan for v0.2, v0.3, v0.4, v0.5, v0.7, and v1.0. **+37 tests, total
164 passing.**

`@ifc-lite/collab`
- **`AutomergeHistorySidecar`** (v0.7): real `@automerge/automerge`
  3.x implementation. Same `HistorySidecar` interface as the in-memory
  variant; adds binary `save()` / `load(bytes)` for
  cross-restart persistence. Branches and merges round-trip through
  the Automerge doc.
- **`buildBranchTree(sidecar)`** (v0.7): pure-data branch-tree
  builder. Returns `{ nodes, edges, branches }` with `branch-anchor` /
  `entry` / `merge` node kinds and `history` / `fork` / `merge` edge
  kinds. Apps render this directly into git-log columns or
  force-directed graphs.
- **Parametric mesh primitives** (v0.3): pure-TS reference kernel.
  `paramsToMesh(source, params)` ships `extruded-area-solid`, `box`,
  `cylinder`, and `revolved-area-solid`. `hashMesh(mesh)` returns a
  32-hex content hash for cache keys.
- **Determinism harness** (v0.3 / open #5):
  `runDeterminismHarness(kernel, fixtures, expected)` + a
  `DEFAULT_FIXTURES` set covering every primitive. CI runs this on
  every platform and fails on drift.
- **`createWebRtcProvider`** (v0.2 §8.1): wraps `y-webrtc` lazily so
  consumers who don't use it pay no bundle cost. Same status /
  whenSynced shape as the websocket provider.
- **`createNumericRegistryAdapter(registry)`** (v0.4): bridges the
  renderer's existing numeric-offset `FederationRegistry` into our
  string-shaped `FederationResolver` without forcing
  `@ifc-lite/collab` to depend on the renderer.
- **`installIfc4ToIfc4x3Migration()`** (v1.0): sample registered
  schema migration that renames `Pset_<…>::<key>` attributes into
  the `bsi::ifc::v5a::Pset_<…>::<key>` namespace. Demonstrates the
  migration plumb for consumers.
- **`createPresenceOverlay({ container, viewport })`** (v0.2): drop-in
  2D canvas overlay that consumes a `PresenceMap` and draws other
  peers' cursors + label badges. `update(peers)` redraws; auto-resizes
  via `ResizeObserver`. Pairs with `peerVisuals` for any DOM viewer.

`@ifc-lite/collab-server`
- **`RedisPersistence`** (v0.5): `Persistence` against a
  `RedisLikeClient` interface (ioredis / node-redis 4+ satisfy it).
  Layout: `<prefix><roomId>:snap` for compacted state, list
  `<prefix><roomId>:log` for rolling frames. Implements
  load / append / compact / drop.
- **Bucketed histograms** (v0.5): `MetricsRegistry.bucketedHistogram(
  name, buckets, help)` accumulates observations into upper-bound
  buckets and renders as a proper Prometheus `histogram` type with
  `le="<bound>"` bucket labels.

Tests added (+37): Automerge sidecar record / save+load / diff /
branch+merge; branch-tree anchor + history edges, fork edges, merge
edges with merge-from-branch annotation; parametric primitives shapes
+ deterministic hashes + dispatch errors; determinism harness happy
path + drift detection; numeric registry adapter forwarding + numeric
guard; IFC4 → IFC4X3 sample migration verifying renames; Redis
persistence append/load + compact/clear + drop; bucketed histograms
counts + label dimensions + empty-bucket guard.

Plan doc: v0.2 ☑ (overlay shipped), v0.3 ☑ (parametric kernel +
determinism harness), v0.4 ☑ (numeric registry adapter), v0.5 ☑
(Redis + bucket histograms), v0.7 ☑ (Automerge sidecar + branch
tree). v1.0 was already ☑; the sample migration finishes the §1.x
"actually IFC schema migrations" caveat.
