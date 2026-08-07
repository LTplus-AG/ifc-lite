---
"@ifc-lite/codegen": patch
"@ifc-lite/parser": patch
---

Fix two corrupted cells in the generated CRC32 lookup table (index 111 and 245), which were hand-typed literals that had silently drifted from the correct reflected CRC-32 (polynomial `0xEDB88320`) values. `packages/codegen` now renders this table from a single `buildCRC32Table()` source of truth in both its TypeScript and Rust templates instead of hand-typing a second copy, so the two cannot diverge again.

The 256-entry `TYPE_IDS` map shipped for every named entity in the schema was never affected — those ids are computed with the correct table at generation time. The corruption only affected `crc32Hash()` / `crc32_hash()` at runtime for entity keywords that are NOT in the map, i.e. the `IfcType::from_str` `Unknown(crc32_hash(...))` fallback reached for unrecognized/vendor-extension entity keywords, which could get a silently wrong stable id for names whose hash computation happened to touch one of the two corrupted cells.

`packages/parser/src/generated/type-ids.ts` regenerated to correct the same two cells.
