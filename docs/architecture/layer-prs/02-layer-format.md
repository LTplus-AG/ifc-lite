# 02: Layer Format

## 2.1 Container

A published layer is a single IFCX (JSON) document: standard IFCX nodes carrying the changed opinions, plus a header block with the provenance manifest (03) under the `ifclite::` namespace. Any IFCX-conformant tool can compose it; tools unaware of the namespace ignore the manifest and still get correct composition (with the tombstone caveat in §2.3).

Optional binary sidecar: cached derived geometry (meshes, BVH) keyed by the layer id, flagged `derived: true`. Sidecars are caches: never diffed, never required, always recomputable (05 §5.6).

## 2.2 Op model

Conceptually, a layer is a set of ops at (entity, component) granularity, aligned with the columnar store and `diff`'s fingerprint scopes:

```text
Op =
  | AddEntity        (id, ifcType, components)
  | TombstoneEntity  (id)                          [§2.3]
  | SetComponent     (id, componentKey, value)     [upsert; LWW within a stack]
  | TombstoneComponent(id, componentKey)
  | SetRelation      (relType, from, to)           [containment, defines, voids, ...]
  | TombstoneRelation(relType, from, to)
```

ComponentKey granularity: `attr:<group>`, `pset:<PsetName>`, `qset:<QsetName>`, `type-assignment`, `placement`, `geometry:<tier>`. This matches the per-component sub-hash mode added to `diff/fingerprint.ts` (05 §5.2) so diff keys and op keys are the same vocabulary.

Ops are **state-based**: a `SetComponent` carries the full component value, not a transform. Composing a stack `[base, L1, L2]` is a fold where stronger layers shadow weaker per (entity, componentKey). Deterministic, order-defined, no OT machinery. This is the existing `layer-stack.ts` strength semantics, formalized.

Serialization note: ops are not a new wire format. They serialize as ordinary IFCX node opinions; the op vocabulary above is the *semantic reading* of a layer's nodes, shared by the composer, the differ, and the merge engine.

## 2.3 Tombstones (deletion overlays)

`minimal-layer.ts` is additive-only today by documented design ("deletion overlays are spec'd for a future version"). This spec is that future version.

A tombstone is an opinion at the entity (or component/relation) path:

```json
{ "path": "</project/storey-EG/wall-3fA...>", "attributes": { "ifclite::deleted": true } }
```

Composition rule (extends `ifcx/composition.ts`): a tombstone at strength *s* shadows **all** opinions at strengths weaker than *s* for that path, including child paths for entity tombstones. A stronger layer may resurrect by setting `ifclite::deleted: false` (this is how a revert layer undoes a deletion).

Conformance note: tools unaware of `ifclite::deleted` will compose the entity as present. Until deletion overlays are standardized upstream (11 §11.2), exporters offer `--bake` to materialize a stack into a tombstone-free document for foreign tools.

## 2.4 Canonical serialization and content addressing

`layerId = blake3(canonical_bytes)` where canonical bytes are produced by:

1. Strip the sidecar and any `derived: true` content
2. Sort all object keys lexicographically; sort node arrays by path with a **stable** sort — the relative order of same-path opinions is semantic (later wins) and is preserved in the canonical bytes
3. Normalize numbers (shortest round-trip representation), strings (NFC), no insignificant whitespace
4. The manifest is included **except** the `signatures` field (signatures sign the id, so they cannot be inside it)

Same canonicalization discipline as `diff/fingerprint.ts` (order-independent, byte-identical across adapters), promoted to whole-document scope. Implementation lives in TS first; a `rust/core` blake3+canonicalization path is added only if profiling on 500MB-class models demands it (Tauri desktop track).

A **stack hash** is blake3 over the ordered list of layer ids: the identity of a composed state. Refs (`main`, `design-option-B`) are named mutable pointers to stack hashes, stored by the registry (10) or a local ref file.

## 2.5 Size and performance budgets

- Layer publish (freeze + canonicalize + hash) for a 10k-op draft: < 500ms in-browser
- Composition of a 50-layer stack over a 1M-entity model: < 2s cold, < 200ms incremental (memoize per-layer path indexes, already present as `nodesByPath`)
- Sidecar hit rate target for viewer open-from-registry: > 90% (no geometry recompute on review)
