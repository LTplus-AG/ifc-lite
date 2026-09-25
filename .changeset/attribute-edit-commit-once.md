---
"@ifc-lite/viewer": patch
---

Editing an attribute in the Properties panel now records a change only when the value actually changed and is valid (#5872).

Clicking into an attribute such as `Name` and clicking away used to record an undo step for the unchanged value, clear the redo history and flag the model as having unsaved changes. An unchanged value now records nothing, and Escape always cancels. A `GlobalId` edit must be 22 characters of the IFC base64 alphabet and not already used by another element in the model; otherwise the field shows why and nothing is written.
