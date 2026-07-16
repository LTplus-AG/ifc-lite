---
"@ifc-lite/wasm": patch
---

Cut wasm exact-CSG geometry time 20-31% (measured on five CSG-heavy models, byte-identical output). wasm32 has no native 128-bit multiply, so the FixedInt exact-predicate tier's u64-limb schoolbook multiplies lowered every partial product to a `__multi3` libcall; the kernel now dispatches to a u32-digit schoolbook on wasm32 (`u32*u32->u64` = one `i64.mul`). Native builds keep the u64/u128 path verbatim. Both digit widths are pinned bit-identical by a new differential fuzz across all supported widths.
