---
"@ifc-lite/renderer": patch
---

Fix `IfcTextLiteralWithExtent` annotation text with a `"top-middle"` or `"bottom-middle"` `BoxAlignment` rendering left-aligned (and `"bottom-middle"` also rendering vertically mid-height) instead of horizontally centered.

The IFC4 `IfcBoxAlignment` WHERE rule pins the enum to `'top-left', 'top-middle', 'top-right', 'middle-left', 'center', 'middle-right', 'bottom-left', 'bottom-middle', 'bottom-right'`. The word `"middle"` is overloaded in that set: it's the vertical qualifier in `"middle-left"`/`"middle-right"` but the *horizontal* qualifier in `"top-middle"`/`"bottom-middle"`. `parseBoxAlignment` in `symbolic-overlay-pipelines.ts` checked `includes('middle')` without regard to position, so it read every `"*-middle"` value as vertical-middle instead of horizontal-center, and never treated `"middle"` as a horizontal signal at all. Compound values are now split on the hyphen so the first token decides vertical and the second decides horizontal, matching the row-then-column order the enum itself uses.
