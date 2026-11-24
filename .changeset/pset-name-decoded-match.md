---
"@ifc-lite/export": patch
---

Editing a property or quantity of a source set whose name holds a non-ASCII letter, an apostrophe or a backslash no longer leaves the source set on the element beside a regenerated copy: the exporter now compares the decoded set name, not the raw STEP text.
