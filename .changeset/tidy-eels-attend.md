---
'@ifc-lite/sdk': patch
'@ifc-lite/sandbox': patch
---

Record why `EntityRelationshipsData`'s field names and the sandbox's dual-cased entity fields are not IFC-fidelity violations, so they stop being re-litigated.

`voids` / `fills` / `groups` / `connections` hold the related **objects**, never the `IfcRel*` entities: `voids` is the `IfcOpeningElement`s that void a host, `fills` the `IfcOpeningElement` a filler sits in. Renaming them to `IfcRelVoidsElement` / `IfcRelFillsElement` would name each field after a type none of its members has, and IFC's own names for these traversals (`HasOpenings`, `FillsVoids`, `HasAssignments`, `ConnectedTo`) are inverse attributes holding the `IfcRel*` entity — so "use the exact EXPRESS name" has no name to offer. `openings` fails too, because `voids` **and** `fills` both hold `IfcOpeningElement`s and only the voids/fills pair distinguishes the two directions. `EntityRelationshipsData` now carries that reasoning, pinned by a parser test.

`withAliases` keeps emitting every entity attribute under both spellings; its doc now names PascalCase as the canonical form (it is the EXPRESS spelling of `GlobalId`, `Name`, `Description` and `ObjectType`) and states why the camelCase half is kept rather than deprecated: sandbox scripts are user-authored with no version channel, and the script editor is CodeMirror with no TypeScript service, so a `@deprecated` tag would reach no one while a removal would break saved scripts silently at runtime. A new test pins the two spellings as symmetric — every attribute present under both, carrying one value — which an exact-shape assertion alone does not guarantee once a seventh attribute is added.

**Scope for these two packages: documentation and tests only** — no runtime, signature or shape change in `@ifc-lite/sdk` or `@ifc-lite/sandbox`.

The PR does migrate runtime code, but not in a published package. `apps/viewer`'s built-in template `construction-schedule.ts` moves from `e.type` / `e.globalId` to the canonical `e.Type` / `e.GlobalId` (identical values; it was the only shipped template still reading a `BimEntity` under the camelCase spelling). `@ifc-lite/viewer` is `"private": true` and carries no changeset for the same reason `apps/viewer/.../bim-globals.d.ts`, regenerated here, carries none: nothing in it is published to a registry.
