---
"@ifc-lite/create": minor
---

`num()` no longer emits invalid STEP REAL tokens for values whose magnitude is >= 1e21 (the point at which `Number.prototype.toFixed` itself switches to exponential notation, defeating the fixed-decimal fallback that made STEP output valid). Such values, and `NaN`/`Infinity`, are now refused with an error naming the offending value instead of being written into the file. `assertPositiveFinite` and `assertFinitePoint3` reject the same magnitude earlier, at the authored-input layer, naming the field. Ordinary values (including large but plausible coordinates far below the bound) serialize exactly as before. This is a behavior change for any caller that was previously handed a broken file for such input — no existing caller relying on that broken output is expected — so it is released as minor rather than patch.
