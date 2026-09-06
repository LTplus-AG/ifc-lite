---
"@ifc-lite/parser": minor
---

`extractClassificationsOnDemand` now resolves real classification attributes on a server-parsed store instead of always returning `[]`.

The server already extracts `IfcRelAssociatesClassification` associations correctly (`system`/`identification`/`name`/`location`, walking the `IfcClassificationReference` chain server-side), but a server-parsed `IfcDataStore` carries no raw source bytes, so `extractClassificationsOnDemand`'s `EntityExtractor`-based decoding always fell through to an empty result — indistinguishable from a genuinely unclassified entity, even when the relationship graph proved otherwise.

`IfcDataStore` gains an optional `resolvedClassifications?: Map<number, ClassificationInfo[]>` field. When present, `extractClassificationsOnDemand` consults it (for the entity itself and, via `IfcRelDefinesByType`, its type) when nonempty, otherwise preserving unresolved markers, so a viewer- or MCP-side IDS check against a server-parsed model can now resolve system- and value-constrained classification facets instead of reporting them as unclassified. The wasm/source-bearing path is unaffected — it still resolves attributes directly from `store.source`.
