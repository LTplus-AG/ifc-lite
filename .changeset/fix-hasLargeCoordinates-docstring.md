---
"@ifc-lite/geometry": patch
---

Correct the `hasLargeCoordinates` docstring on `CoordinateInfo`: it only
tracks whether the JS-side `originShift` fired, and stays `false` when the
WASM mesh pass already re-based the model onto `wasmRtcOffset` instead. It is
not a general "was this model shifted?" flag; `wasmRtcOffset !== undefined`
is. No behaviour change.
