---
"@ifc-lite/viewer": patch
---

Fix `loadListDefinitions` returning non-array JSON verbatim, bricking the List panel on a corrupt or hand-edited `localStorage` entry.

`loadListDefinitions` parsed the stored value and cast it straight to `ListDefinition[]` without checking it actually was an array. A hand-edited entry, or any well-formed JSON that isn't an array (an object, a stray number, `null`), came back unchanged. `listSlice.addListDefinition` spreads that result (`[...listDefinitions, def]`) on the very first list the user creates, so a non-array value threw `TypeError: ... is not iterable` at that point instead of the panel just starting empty. `loadListDefinitions` now falls back to `[]` for any parsed value that isn't an array, the same way it already does for unparsable JSON.
