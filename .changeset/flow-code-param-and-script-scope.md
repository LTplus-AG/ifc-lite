---
'@ifc-lite/flow': minor
'@ifc-lite/flow-nodes': minor
---

Make the Flow Script node usable over a list, and give its source a real editor.

`ParamKind` gains `'code'` (with an optional `language`), which tells a host that the parameter needs a multi-line editor rather than the single-line `<input>` a `'string'` gets. `script.run`'s `code` parameter now declares it. The value is still a plain string, so a host without a code editor degrades to the string field.

**Fixed: a Script node laced over a list only ever computed its first lane.** Every lane shares one sandbox and QuickJS evaluates a program in the *global* lexical scope, so the second lane's `const inputs = …` — and any `const` in the user's own code — threw "redeclaration of 'x'". The lane error was logged and that lane yielded `null`, which a downstream `core.filter` reads as a legitimate answer, so a per-element script silently produced wrong results for every element but the first. The source is now evaluated through a direct `eval` inside a function, giving each lane its own variable environment while keeping both contract points: `inputs` in scope, and the last expression as the value.

New node `script.list` ("Script (list)"): the same sandbox with `list` ports instead of `item` ports, so the code sees whole lists and returns an array. Sorting, ranking, top-N and de-duplication are not expressible per element; they are three lines here. A result that is not an array is rejected rather than handed to a list port.
