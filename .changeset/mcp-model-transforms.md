---
"@ifc-lite/mcp": minor
"@ifc-lite/export": minor
"@ifc-lite/cli": patch
---

MCP: add `model_merge`, `model_convert`, `model_extract`, `model_anonymize`, `model_simplify` and `model_lod`, the CLI's model transforms. Each writes a new file and declares a title, annotations and an `outputSchema`; tools can now declare `outputSchema` in `tools/list`.

`@ifc-lite/export` now holds the raw STEP subset engine behind `ifc-lite extract-entities` (`parseStep`, `selectSubsetSeeds`, `buildSubset`, `serializeSubset`, and `SubsetSelectionError` for selectors that match nothing), so the CLI and MCP share one implementation.

`ifc-lite extract-entities --storey` now matches the storey's decoded Name exactly (doubled quotes, `\X2\` escapes and raw UTF-8 included) instead of any quoted text in the record, refuses a name two storeys share, and reads a bare number that is no storey id as a name.
