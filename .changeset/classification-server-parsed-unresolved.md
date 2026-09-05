---
"@ifc-lite/parser": minor
"@ifc-lite/ids": patch
---

Fix a server-parsed (source-empty) store reporting a genuinely classified entity as unclassified (#3948). `extractClassificationsOnDemand` and `extractClassificationSystemsOnDemand` (`packages/parser/src/classification-resolver.ts`) resolved classification ids via the relationship graph on server-parsed stores, then unconditionally discarded the result with `if (!store.source?.length) return [];` — a classified entity was byte-identical to an unclassified one to every caller, including the IDS bridge.

The classification's own attributes (system name, identification code, reference chain) genuinely cannot be read without raw STEP bytes, and no equivalent precomputed table exists for them on a server-parsed store (unlike type-inherited property sets, fixed for the same shape of bug in #1795/#1787). So both functions now signal "classified, but unresolved" distinctly from "genuinely unclassified": `extractClassificationsOnDemand` returns one `{ unresolved: true }` entry per resolved id instead of `[]`, and `extractClassificationSystemsOnDemand`'s return type changes from `string[]` to `{ names: string[]; unresolved: boolean }` (a breaking signature change with no known external callers today).

The IDS classification facet checker (`packages/ids/src/facets/classification-facet.ts`) now treats presence-only facets correctly (a classified entity passes an "any classification" requirement instead of a false `CLASSIFICATION_MISSING`), and reports a new `CLASSIFICATION_UNRESOLVED` failure — distinct from `CLASSIFICATION_MISSING`/`CLASSIFICATION_VALUE_MISMATCH`/`CLASSIFICATION_SYSTEM_MISMATCH` — when a system/value-constrained facet cannot be verified because the matching classification's attributes are unreadable, instead of silently passing or failing on data it never read.
