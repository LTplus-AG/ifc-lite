---
"@ifc-lite/lens": patch
---

Fix `hexToRgba` silently producing a `NaN` color channel for the 3-digit CSS shorthand hex form (`#fff`, `#e53`) and other malformed input (empty string, non-hex characters, wrong length). `hex` is not always a native `<input type="color">` value: it also arrives from imported lens JSON — which carries no schema validation on `rule.color` — and from the SDK's `bim.viewer.colorize()` / `colorizeAll()`, published entry points that pass a caller-supplied string straight through. `hexToRgba` now expands the 3-digit shorthand and falls back to `0` per malformed channel instead of leaking `NaN` into the returned RGBA tuple. Well-formed 6-digit input is unaffected.
