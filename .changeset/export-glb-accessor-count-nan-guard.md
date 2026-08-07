---
"@ifc-lite/export": patch
---

Fix the export package's own (parallel, `@ifc-lite/cache`-independent) GLB reader silently decoding an empty mesh instead of erroring when an accessor's `count` is present but non-numeric.

`readAccessor` computed `count` as `Number(acc.count || 0)`: the `|| 0` only substitutes a default for a *missing* count — a present-but-bogus value (a corrupted JSON chunk with `"count":"abc"`) survives it and becomes `NaN`. The bounds check right below it (`byteOffset + byteLen > bin.byteLength`) is a bare comparison, so `NaN > bin.byteLength` evaluated `false` and the guard was bypassed; `bin.subarray(offset, NaN)` then silently returned an empty view, and the accessor decoded as a mesh with zero vertices/indices rather than a diagnosable error. `count` is now validated as a non-negative integer before use; a valid `count` (including `0`) is unaffected.
