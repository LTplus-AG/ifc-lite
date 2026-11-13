---
"@ifc-lite/parser": patch
---

The browser parser worker no longer carries jszip and decimal.js. It imported `IfcParser` from the package index, which also reaches `.ifczip` unwrapping and the cost evaluator, so both libraries were in the worker bundle (about 130 KB) and were evaluated every time a worker started, though the worker uses neither. `IfcParser` now lives in its own module and the index re-exports it unchanged.
