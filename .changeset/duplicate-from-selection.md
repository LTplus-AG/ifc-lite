---
"@ifc-lite/create": minor
"@ifc-lite/mutations": minor
"@ifc-lite/viewer": minor
---

Duplicate-from-selection — pick any IfcRoot product, hit `⌘D` (or
right-click → Duplicate), get a fully-functional clone. The
duplicate is a first-class entity in the property panel, exports
cleanly to STEP with all its property associations preserved, and
ships in 6 directional variants sized to the source's bounding box.

**`@ifc-lite/create`**
  - New `duplicateInStore(editor, source, options)` pure builder.
    Emits a fresh placement chain (`IfcCartesianPoint` →
    `IfcAxis2Placement3D` → `IfcLocalPlacement`) plus the duplicate
    `IfcRoot` with a new GUID and the source's `Representation`
    reference reused (geometry shared). Optional fresh
    `IfcRelContainedInSpatialStructure` anchors to the source's
    storey. Offset is configurable via `options.offset` — the slice
    sizes it to the source's bbox.
  - New `resolveDuplicateSource(store, expressId)` walks the parsed
    `IfcDataStore` for placement / parent / location / storey /
    associations.
  - New `SourceAssociation` shape captures one
    `IfcRelDefines*` / `IfcRelAssociates*` edge that references
    the source. The builder replays each one against the duplicate
    so the exported STEP carries identical psets / qsets /
    materials / classifications / documents / type binding —
    without modifying any existing rel.
  - Resolver scans the five association rel types
    (`IFCRELDEFINESBYPROPERTIES`, `IFCRELDEFINESBYTYPE`,
    `IFCRELASSOCIATESMATERIAL`, `…CLASSIFICATION`, `…DOCUMENT`)
    by direct numeric membership in `RelatedObjects`.
  - `DuplicateBuildResult.associationRelIds: number[]` exposes the
    fresh rel ids for caller introspection.
  - 7 unit tests in `duplicate.test.ts`: full graph emission,
    custom offset, no-storey path, root-placement parent, attribute
    count guard, association replay (3 rel types in one go), and
    the no-associations case.

**`@ifc-lite/mutations`**
  - New `setEntityAlias(overlayId, sourceId | null)` /
    `getEntityAlias(id)` / `resolveBaseEntityId(id)` public surface
    on `MutablePropertyView`. Aliases redirect base property and
    quantity reads from the duplicate to its source — so the
    duplicate inherits psets/qsets without eagerly cloning them
    into the overlay.
  - Override slots stay scoped to the original (overlay) id, so
    edits on the duplicate don't bleed into the source. Verified
    by 4 new unit tests including the source-untouched path,
    chain-cap (one hop, not transitive), and the self-alias guard.

**`@ifc-lite/viewer`**
  - New `duplicateEntity(modelId, sourceExpressId, direction?)`
    slice action. Wraps the create-package builder, sets the
    mutation-view alias, and clones the source's mesh data into
    the geometry result with the offset applied — so the duplicate
    appears in 3D the moment the action fires, not just in the
    export overlay. Per-vertex `entityIds` arrays are filled with
    the new globalId so picking and selection resolve correctly.
  - New `DuplicateDirection` type (`+X` / `-X` / `+Y` / `-Y` /
    `+Z` / `-Z`). Magnitude per axis = the source's bounding-box
    dimension on that axis, so a 3m wall steps 3m and a 0.4m
    column steps 0.4m. Falls back to a 1m step when the source
    has no mesh in geometry.
  - Right-click menu's "Duplicate" item is now a `DuplicateRow`:
    primary clickable label on the left (defaults to +X), 6 axis
    chips on the right (→ ← ↗ ↙ ↑ ↓). Tooltips spell out
    "+X (east)" through "−Z (down)".
  - `⌘D` defaults to +X. `⇧⌘D` = +Z (up), `⌥⌘D` = +Y (north) —
    modifier shortcuts for power users without forcing a mouse
    trip to the chip row. Selection moves to the new globalId so
    a Cmd+D chain ("stamp a row of columns") works without
    re-clicking.
  - **`resolveGlobalIdFromModels` two-pass overlay fallback** —
    the federation resolver previously gated each model's id range
    at parse-time `maxExpressId`, which excluded every
    overlay-allocated id from selection. The fix: a second pass
    consults each model's mutation view via `getNewEntity(localId)`
    so overlay duplicates resolve to the right model with the
    right local id. Without this, the property panel saw the
    duplicate as "UNKNOWN / Unknown / no property sets" because
    the alias couldn't take effect on a wrongly-resolved id.
  - PropertiesPanel falls back to the overlay `NewEntity` record
    for type / name / GUID / Description / ObjectType when the
    parsed `entityNode` comes up empty. The bSDD attribute list
    synthesises from the schema-defined positional names. The
    Materials / Classifications / Documents / structural
    Relationships sections all route through a new
    `lookupExpressId` (alias-resolved) so they query the source's
    parsed maps directly.

After: a freshly-duplicated wall is genuinely first-class — name
reads, properties show, quantities show, material layers show,
classifications show, documents show, and a round-tripped STEP
file carries every association.
