---
"@ifc-lite/sdk": minor
---

A prepared Room command has an optional `current()`: a cheap, non-throwing check of whether `validate()` would still pass, by the same checks (#10792). A geometry provider may supply `NativeRoomGeometry.current` as the cheap form of its `validate`, and `current()` then compares geometry through it.
