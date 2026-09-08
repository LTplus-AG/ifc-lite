---
"@ifc-lite/create": minor
---

Export `toNativeLength` and its new inverse `fromNativeLength` (`in-store/anchor.ts`) from the package index. `fromNativeLength` converts a value stored in a model's native length unit back to metres — the counterpart a read-side translator needs to invert what `toNativeLength` scaled on write, without a second implementation of the same rounding rule. Added for issue #4153's read side (`apps/viewer`'s drawing-markup reader, not part of this package); no existing export changed.
