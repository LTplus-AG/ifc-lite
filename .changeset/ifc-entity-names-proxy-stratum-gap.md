---
"@ifc-lite/data": patch
---

Add the four entities missing from `IFC_ENTITY_NAMES` — `IfcProxy`, `IfcSolidStratum`, `IfcVoidStratum`, `IfcWaterStratum`. All four are representable in `IfcTypeEnum`/`IfcTypeEnumToString`, but were absent from the UPPERCASE→PascalCase table, so any direct `IFC_ENTITY_NAMES[upper] ?? upper` lookup fell through to the raw UPPERCASE STEP keyword instead of the PascalCase name. That affects `@ifc-lite/mcp`'s `query`/`diff`/`validation`/`discovery` tools and `@ifc-lite/cli`'s `info`/`diff` commands whenever a model contains one of these types — and `IFCPROXY` in particular is minted by `schema-converter.ts` itself when downgrading IFC4X3 entities to IFC4, so it is not an exotic case.

The file's header claimed it was auto-generated and must not be edited by hand, naming `scripts/generate-entity-names.ts` as the way to regenerate it. That script does not exist anywhere in the repository and is referenced nowhere else, so the table is in practice maintained by hand and no regeneration path was available to fix the drift. The header now says so, rather than directing the next maintainer to a command that cannot be run.

A completeness test (`ifc-entity-names.test.ts`) now pins every `IfcTypeEnum` member with a known PascalCase spelling against `IFC_ENTITY_NAMES`, so future drift — including a regeneration that drops entries again — fails loudly instead of silently degrading display names.
