---
"@ifc-lite/codegen": patch
---

Fix a fourth checked-in copy of the corrupted CRC32 lookup table (index 111 and 245, see the earlier CRC32 table-corruption changeset) that the prior regeneration missed: `packages/codegen/generated/ifc4x3/type-ids.ts`. Its generator (`packages/codegen/src/type-ids-generator.ts`, run via `pnpm generate:ifc4x3`) already rendered the table from `formatCRC32TableLiteral()`/`buildCRC32Table()`, the single source of truth — the file itself simply hadn't been re-run after that fix landed, so it still shipped the two hand-typed-wrong cells.

This artifact is not imported by `packages/parser` or `rust/core` (unlike the sibling `generated/ifc4/type-ids.ts`, which is copied into `packages/parser/src/generated/`), so its `TYPE_IDS` map and its `crc32Hash()` runtime fallback were not reachable from any current runtime code path. Regenerating it corrects the checked-in artifact so it matches the canonical table and stays correct if it is ever consumed.

Regenerated diff is exactly the two constants (index 111 and 245), no unrelated churn. Added a test (`packages/codegen/test/type-ids-generator.test.ts`) that reads both checked-in `generated/ifc4/type-ids.ts` and `generated/ifc4x3/type-ids.ts` from disk and asserts their `CRC32_TABLE` matches `buildCRC32Table()` in all 256 cells, so a regenerated-but-not-committed (or committed-but-stale) artifact can't silently drift from the generator again.
