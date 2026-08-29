---
'@ifc-lite/viewer': patch
---

Four sites in `PropertyEditor.tsx` and `BulkPropertyEditor.tsx` used `parseFloat(value) || 0` / `parseInt(value, 10) || 0` when committing a user-entered Real/Integer property or quantity value. `NaN || 0` is `0`, so a value that didn't parse as a number silently wrote a real `0` into the model — indistinguishable from a value the user actually entered, with no error shown anywhere. Same defect as #3456's `CsvConnector.parseValue` fix.

`PropertyEditor`'s inline commit (`commitSave`) and its "Add Property" dialog now refuse the save and show the existing `toast.error` notification instead of writing the fabricated value; the "Add Quantity" dialog does the same. An empty Real/Integer field now commits as `null` (unset), matching the convention the Boolean/Logical arm already used one case above it. A genuinely-entered `"0"` still writes `0`.

`BulkPropertyEditor`'s single parsed value is reused for every entity in the matched selection, so a bad value previously fabricated a `0` across the whole selection at once. `buildAction` now returns a failure instead of an action, and both Preview and Execute refuse the whole operation before touching a single entity — surfaced through the component's own execute-result Alert, the pattern it already uses for a failed run — rather than half-applying a default across some but not all of the selection.
