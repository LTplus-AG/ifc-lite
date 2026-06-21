---
"@ifc-lite/renderer": minor
---

Add `ghostExceptIds` / `ghostAlpha` to `RenderOptions` — an X-Ray *context* mode
that fades every non-selected mesh NOT in the set to a translucent alpha, while
the focused subset stays solid. It feeds the existing `transparencyOverrides`
alpha path (explicit per-id entries still win, selected meshes stay opaque), so
callers can ghost "the rest" of a model without building a Map over every
element. Same id space as `isolatedIds`.
