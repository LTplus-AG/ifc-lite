---
"@ifc-lite/mcp": patch
---

Fix two declared-but-ignored MCP tool inputs.

`ids_validate`'s `locale` field (`en`/`de`/`fr`) was read into a variable and immediately discarded (`void input.locale`); no translator was ever built, so every call produced English `failureReason` / requirement-description text regardless of the requested locale. It now builds a `@ifc-lite/ids` translation service from `locale` and passes it into `validateIDS`, so `de`/`fr` actually translate the report.

`geometry_bbox` / `geometry_volume` / `geometry_area`'s `global_id` / `global_ids` selectors resolved by scanning the parsed store directly, never consulting the session's pending-mutation overlay. That put them out of step with every other GlobalId-keyed tool (`get_entity`, `query_entities`, `bsdd_match`, `entity_delete`, ...), which all fold the overlay per the #2014/#2015 one-resolution-rule: an entity created this session (`entity_create`) was invisible to the geometry tools by GlobalId even though `get_entity` found it immediately, and an entity queued for deletion (`entity_delete`) stayed resolvable there after `get_entity` already reported it gone. `resolveExpressIds` now resolves `global_id`/`global_ids` through the same overlay-aware `resolveGlobalIds` helper `get_entity` and `entity_delete` use.
