---
"@ifc-lite/create": patch
"@ifc-lite/encoding": patch
---

Reject `IfcCreator` `Timestamp` values that are finite but outside the ±8.64e15 ms Date range. They previously cleared the `Number.isFinite` guard and failed much later as a `RangeError` from `toISOString()` while writing the file header; they are now rejected in the constructor, where the error can still name the parameter. Also corrects the `RandomSource` documentation: the unseeded path uses Web Crypto when the runtime provides it and falls back to `Math.random` when it does not, rather than guaranteeing a platform CSPRNG.
