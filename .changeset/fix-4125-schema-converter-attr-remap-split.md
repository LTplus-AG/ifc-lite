---
"@ifc-lite/export": patch
---

`schema-converter-attr-remap.ts`'s `splitTopLevelAttributes` no longer carries its own copy of the top-level-STEP-comma-split rule; it now delegates to `step-argument-parser.ts`'s `splitTopLevelArgs`, the same package's general-purpose splitter already used by seven other read paths. No observable output change for `remapRenamedAttributesByName`'s real (IFCDOORTYPE/IFCWINDOWTYPE) inputs.
