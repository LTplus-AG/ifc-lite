---
"@ifc-lite/mcp": minor
"@ifc-lite/export": minor
"@ifc-lite/cli": patch
---

MCP: add `model_merge`, `model_convert`, `model_extract`, `model_anonymize`, `model_simplify` and `model_lod`, the CLI's model transforms. Each writes to `file_path` (replacing a file already there, never a loaded model's source) and declares a title, annotations and an `outputSchema`; tools can now declare `outputSchema` in `tools/list`.

`@ifc-lite/export` now holds the raw STEP subset engine behind `ifc-lite extract-entities` (`parseStep`, `selectSubsetSeeds`, `buildSubset`, `serializeSubset`, and `SubsetSelectionError` for selectors that match nothing), so the CLI and MCP share one implementation.

`ifc-lite extract-entities --storey` now matches the storey's decoded Name exactly, then its LongName (doubled quotes, `\X2\` escapes and raw UTF-8 included), instead of any quoted text in the record, refuses a name two storeys share, reads a bare number that is no storey id as a name, and selects the storey plus its elements by spatial ownership: contained in it or in a space it aggregates (openings and assembly parts follow their host), with the placement chain deciding only for elements no storey owns. Storeys that share a placement no longer leak into each other.

The subset parser treats `/* */` comments as trivia (between records, inside records and around references), finds `DATA;` outside header strings, and reads a record that follows `DATA;` on the same line. Void, fill and projection relations are kept with their host.
