---
"@ifc-lite/sandbox": patch
---

Fix `bim.export.ifc()` (and any other `returns: 'value'` bridge method) handing a sandboxed script `{ "0": …, "1": … }` instead of a real array when the SDK returns a `Uint8Array`.

`marshalValue` walked non-array objects with `Object.entries`, and a typed array's own enumerable properties are its indices — so the marshalled value had no `.length`, failed `Array.isArray()`, and was not iterable. `sdk.export.ifc()` returns `Uint8Array` chunks once STEP output exceeds V8's string-length limit, so this only showed up on large exports: a script that worked fine against a small model silently got junk on a large one. `marshalValue` now detects any `ArrayBuffer`-backed view and converts it with `Array.from()` before marshalling, the same fix already applied to the sandbox's other value-marshalling path. `DataView` (no index keys to begin with) and `BigInt64Array` / `BigUint64Array` (bigint elements have no representation here and would marshal to an array of `null`s indistinguishable from real data) are excluded and keep their previous object shape, and a view whose `ArrayBuffer` has been detached — what transferring it to a worker leaves behind — degrades to `{}` instead of throwing out of the whole `bim.*` call.
