---
'@ifc-lite/sandbox': patch
---

`bim.viewer.resetColors()` in sandbox scripts always reset every color override in the model. The SDK method it wraps (`resetColors(refs?: EntityRef[])`) already supports resetting only the given entities' colors, but the sandbox schema declared `resetColors` with zero parameters, so a script had no way to pass any — the capability was unreachable from user scripts, the editor's completions, and the LLM system prompt. `resetColors` now takes an optional `entities` argument and forwards it; calling it with no arguments still resets everything.
