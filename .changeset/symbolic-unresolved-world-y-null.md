---
"@ifc-lite/server-client": minor
---

Declare the unresolved-elevation sentinel on `symbolic_data`: `SymbolicGridAxis`, `SymbolicPolyline`, `SymbolicCircle`, `SymbolicText` and `SymbolicFillArea` now type `world_y` as `number | null` instead of `number`.

**This is a type correction, not a wire change.** The server has always been able to send `null` here. `world_y` is `f32::NAN` in the Rust model when the placement chain resolved no elevation, and `serde_json` writes a non-finite float as JSON `null` — so the payload already carried `null` while the declaration promised `number`. `hatch_angle_secondary` on `SymbolicFillArea` was already declared `number | null` for exactly this reason; the elevation fields were the ones left lying. The bytes on the wire are byte-identical before and after, now pinned by a fixture emitted from the Rust serializer itself (`packages/server-client/src/__fixtures__/symbolic-unresolved-wire.json`) and asserted from both sides.

**`null` is not `0`.** `world_y: 0` is a real elevation at datum; `world_y: null` means the server never resolved one. Branch on `x === null` — do not coerce, because `Number(null)` is `0` and would silently invent a datum-level elevation for every unresolved primitive. Anything that buckets, sorts or filters by elevation must exclude the `null`s rather than fold them into the zero bucket. An omitted key stays distinct from both: the server rejects a payload with `world_y` missing outright, so a truncated body can never masquerade as "elevation unknown".

**Migrating.** Marked `minor` because the widened type can fail compilation where the old one did not: `const y: number = axis.world_y` now needs a `null` branch (or `?? fallback`, chosen deliberately). No runtime behaviour changes for a consumer that was already handling the values it actually received.

Shipped alongside a Rust-side fix (`ifc-lite-processing`, `ifc-lite-server`) for the same sentinel: the derived `Deserialize` could not read `null` back into an `f32` (`invalid type: null, expected f32`), so the server's own symbolic cache could not re-read the blob it had just written. One unresolved scalar anywhere in a model made the entire `{cache_key}-symbolic-v1` entry unparseable, and `load_cached_symbolic`'s error fallback then served `SymbolicData::default()` — every replayed request silently returned no 2D symbols at all, for the whole model.
