---
"@ifc-lite/geometry": patch
---

Correct the `hasLargeCoordinates` docstring on `CoordinateInfo`: it only
tracks whether the JS-side `originShift` fired, and stays `false` when the
WASM mesh pass already re-based the model onto `wasmRtcOffset` instead.
Neither field alone is a general "was this model shifted?" flag; use
`hasLargeCoordinates || wasmRtcOffset !== undefined`. No behaviour change.
