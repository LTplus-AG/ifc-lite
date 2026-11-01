---
"@ifc-lite/export": patch
---

`editOwnershipRefusal` decodes an edited source record through `source.decodeUtf8` instead of `TextDecoder` over `source.slice()`. A resident source's slice is a view over its buffer, usually a `SharedArrayBuffer`, which browsers' `TextDecoder` rejects, so every in-place edit that re-read a changed source record threw.
