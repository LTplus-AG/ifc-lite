---
"@ifc-lite/parser": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
"@ifc-lite/viewer": patch
---

Adapters for the successor-matching work (issue #4955). **parser**: `spatialContainerPath` (an element's nearest spatial container as a name path, never GlobalIds) and `authoredKeyValue` / `parseAuthoredKeySpec` (an authored identifier: `Tag`, or `Pset.Prop`), shared by every diff adapter so three copies cannot drift. **cli**: `diff --key-from Tag|Pset.Prop` keys the comparison on an authored identifier (`prop:<value>` where present and unique, GlobalId elsewhere, shared values refused with a warning); `--lineage-out` / `--lineage-in` write and replay the 1:k lineage; `--accept <map.json>` folds a reviewed identity map into it as `replaced`; `--lineage-out` refuses to overwrite an input model like `--identity-out` does; and a new `ifc-lite rekey <table.csv|json> --lineage F --out F [--key-column] [--policy] [--orphans]` carries an external table across a revision. Every fingerprint now carries `container`. **mcp**: `model_diff` gains `key_from` and echoes `keyProperty` / `duplicateAuthoredKeys`. **viewer**: the compare adapter accepts `keyProperty` and fills `container`; a report row compared on an authored key exports it in a `Key` column (present only when one was used, so existing CSVs are byte-identical) and never in the GlobalId column; BCF text prints `Key:` for it.
