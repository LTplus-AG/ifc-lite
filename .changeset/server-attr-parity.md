---
"@ifc-lite/server-client": minor
"@ifc-lite/data": minor
---

Server-parse path now resolves the Lists attribute columns `Description`, `ObjectType`, `PredefinedType`, and `Tag` identically to the in-browser (WASM) path (#1765). The server extracts them at the SAME schema-registry positions the WASM path resolves attribute names against — via a Rust index table generated from `@ifc-lite/parser`'s `SCHEMA_REGISTRY` (`scripts/generate-server-attr-indices.mjs`) — so the traps hold on both paths: `IfcSite` attr 7 (LongName) never surfaces as Tag, `IfcWallType` attr 4 (ApplicableOccurrence) never surfaces as ObjectType, and `CompositionType` enums never leak into PredefinedType. Data-model payload bumped to v4 with nullable `description`/`object_type`/`tag`/`predefined_type` entity columns; `@ifc-lite/data`'s `EntityTable` gains optional `getTag`/`getPredefinedType` accessors (server-parsed stores implement them; the WASM path keeps its on-demand source extraction).
