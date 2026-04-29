---
"@ifc-lite/export": minor
---

`StepExporter` improvements for the overlay-driven add/duplicate/edit flow.

  - Overlay-created entities (`view.createEntity()` / `store.addEntity()`)
    now respect `includeGeometry: false` and the `visibleOnly` /
    `allowedEntityIds` closure — same filters that already apply to
    source entities. Without this a freshly-added wall would smuggle
    its `IfcCartesianPoint`/`IfcExtrudedAreaSolid` helpers past
    `exportPropertiesOnly()`.
  - `deltaOnly` mode now keeps overlay-created entities even when no
    other modifications exist — the early-return predicate consults
    `mutationView.getNewEntities()` and `newGeorefLines` so a
    `createEntity()`-only edit isn't silently dropped from the
    delta. Regression test
    (`emits overlay-created entities under deltaOnly when no other
    modifications exist`) locks this behaviour in.
  - `serializeStepArgs` / `serializeStepValue` are exported from
    `@ifc-lite/export/step-serialization` so the overlay-emit path
    and the rest of the codebase share one canonical STEP-formatting
    implementation.
