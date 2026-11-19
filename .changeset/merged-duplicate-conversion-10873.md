---
"@ifc-lite/export": patch
---

A merged STEP export writes one coordinate operation per representation context. Two models' operations and CRSs merge onto one shared context only when they are equal in every attribute, WKT included. Otherwise the later model keeps its own context and operation, so nothing is dropped. That includes two spellings of one georeference, such as an explicit metre MapUnit and `$`. The shared context used to keep each model's copy, which `HasCoordinateOperation SET [0:1]` forbids.
