---
"@ifc-lite/parser": major
"@ifc-lite/export": patch
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
---

**Breaking:** `IfcDataStore.source` is now an `IfcSourceBytes` accessor instead of a `Uint8Array` (#2183).

On a 342 MB model the source is 327 MB of the ~671 MB the viewer's main thread holds, and it is resident for the model's whole lifetime because property and attribute reads slice it synchronously during render. The contract "here are all the bytes, contiguous, forever" is what blocks any cheaper representation; the accessor replaces it with "ask for the range you need", which makes every whole-file consumer an explicit `materialize()` call you can see and count.

This release is behaviour-neutral: the only implementation shipped is the contiguous one, whose `slice` is a `subarray`. STEP export is byte-identical across the default, header-fallback, `visibleOnly`, merged and merged-`visibleOnly` paths (verified against a 44,249-entity model, both new reads mutation-checked). The compressed block-backed implementation lands behind the same interface.

**Migrating.** Most guards need no change: `byteLength`, `length` and truthiness behave exactly as they did, so the existing `!store.source?.length` shape still compiles and still means the same thing.

- Reading a range — `store.source.slice(a, b)` and `new TextDecoder().decode(...)` become `store.source.decodeUtf8(a, b)`. `slice` still returns a view.
- Needing the whole file — `store.source.withMaterialized(bytes => ...)` (or `withMaterializedAsync`), which scopes the buffer so it cannot outlive the call. `materialize()` exists for the cases where scoping is impractical.
- Constructing a store — wrap with `contiguousSourceBytes(bytes)`, or `EMPTY_SOURCE_BYTES` for stores with no source (server-parsed, synthetic, GLB, point cloud). Helpers that must accept both shapes can normalise with `asSourceBytes`.
- `parseSourceHeader` now accepts either shape and reads only the first 64 KiB, so exporters no longer materialise a whole file to read its header.
- `fromTransport` passes an `IfcSourceBytes` argument straight through rather than re-wrapping it. Hydrating several stores from one source (the streaming parser's partial + final pair) should share one accessor, so the memoised `contentKey` is computed once.
- `toTransferable()` no longer forces the `contentKey` hash. Describing a source for a worker is meant to be cheap; computing the key there would walk the whole file on the sending thread. It now carries the key only when something has already computed it, and `sourceBytesFromTransferable` reads a `null` key as "not computed yet" so the receiver hashes lazily to the same value.

New exports from `@ifc-lite/parser`: `contiguousSourceBytes`, `EMPTY_SOURCE_BYTES`, `isSourceBytes`, `sourceBytesFromTransferable`, and the `IfcSourceTransfer` type. (`toTransferable` is on the public interface, so its inverse belongs in the same surface -- otherwise a consumer can produce a transfer envelope with no supported way to rehydrate one.) (`asSourceBytes` and the `IfcSourceBytes` type were already exported by the widening step above.)

`isSourceBytes` is exported because a store built behind an `as unknown as` cast cannot be type-checked on this field, so the contract has to be assertable at runtime -- which is how a producer that kept handing over a raw `Uint8Array` was found.
