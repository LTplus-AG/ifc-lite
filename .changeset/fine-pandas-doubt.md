---
"@ifc-lite/parser": minor
---

Allow inherited type quantity extraction to read a current native mutation view, preserving the source-only default and the shared quantity collector rules.

Expose bounded current-read coverage through `readCurrentTypeQuantities` and `CurrentTypeQuantityResult`, so unsupported or unreadable native inherited quantities remain explicitly unknown without stale source fallback.

Resolve explicit quantity units through the canonical unit resolver using current native records; refuse unreadable, cyclic, or oversized current unit dependencies rather than reporting stale available scales.

Expose bounded `readCurrentProjectUnits` coverage and an optional native provider for canonical project-unit extraction. Current properties and zone quantity cards follow native project unit edits and assignment changes without fabricating explicit units on implicit quantities; unreadable contexts remain unknown instead of restoring stale physical bases.
