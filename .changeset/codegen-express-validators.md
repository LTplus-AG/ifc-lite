---
"@ifc-lite/codegen": minor
---

`@ifc-lite/codegen` compiles the constraint side of an EXPRESS schema as well as its types. `generateValidators(source)` (CLI: `--validators <dir>`) translates every WHERE rule, DERIVE expression, FUNCTION and global RULE to TypeScript, and emits schema tables and zod 4 schemas for the authoring form of every entity and type, for the `@ifc-lite/validate` runtime. A construct it cannot compile is listed with its reason in the generated coverage, never dropped. All rules of IFC2X3 TC1, IFC4 ADD2 TC1 and IFC4X3 compile. Translator by @quotentiroler.
