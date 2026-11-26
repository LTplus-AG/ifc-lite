---
"@ifc-lite/mcp": minor
"@ifc-lite/export": minor
"@ifc-lite/cli": patch
---

MCP: add `model_merge`, `model_convert`, `model_extract`, `model_anonymize`, `model_simplify` and `model_lod`, the CLI's model transforms. Each writes a new file and declares a title, annotations and an `outputSchema`; tools can now declare `outputSchema` in `tools/list`.

`@ifc-lite/export` now holds the raw STEP subset engine behind `ifc-lite extract-entities` (`parseStep`, `selectSubsetSeeds`, `buildSubset`, `serializeSubset`), so the CLI and MCP share one implementation.
