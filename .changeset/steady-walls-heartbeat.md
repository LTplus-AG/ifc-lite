---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": patch
---

Geometry workers now report progress from inside a long batch call, so a slow element (for example a wall with hundreds of curved openings) is no longer mistaken for a hung call. Previously the pool replaced such a worker after 45 s and skipped the element after another 90 s, so whether the element loaded depended on the user's CPU speed and the replay added up to two minutes. The kernel emits coarse progress points; `@ifc-lite/wasm` adds `setGeometryProgressCallback`, rate-limited to one call a second. Geometry output is unchanged; calls that stop reporting are still recovered as before, and any single call is still bounded at 10 minutes even while it reports progress.
