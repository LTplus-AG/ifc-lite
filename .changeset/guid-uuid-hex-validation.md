---
"@ifc-lite/encoding": patch
---

Reject a UUID string containing non-hexadecimal characters in `uuidToIfcGuid` instead of silently zeroing them. The function stripped dashes and checked the resulting string's length (32), but never checked that every character was actually a hex digit — `parseInt('gg', 16)` returns `NaN`, and `Uint8Array` coerces `NaN` to `0`, so a garbage input like `'gggggggg-gggg-gggg-gggg-gggggggggggg'` silently produced the all-zero UUID's GUID instead of throwing. `uuidToIfcGuid` is reachable with arbitrary caller-supplied strings via the SDK's `bcf.uuidToIfcGuid`.
