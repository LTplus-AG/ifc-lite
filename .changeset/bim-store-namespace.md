---
"@ifc-lite/mutations": minor
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/sandbox": minor
"@ifc-lite/cli": minor
"@ifc-lite/viewer": minor
"@ifc-lite/parser": patch
"@ifc-lite/geometry": patch
"@ifc-lite/renderer": patch
---

Add the `bim.store.*` namespace — high-level editing of an already-parsed
`IfcDataStore` via the existing mutation overlay. Closes the merge-roundtrip
gap from #592 (you can edit `IfcRectangleProfileDef.XDim` or drop a fresh
`IfcColumn` into a model without round-tripping through a script + re-parse).

**`@ifc-lite/mutations`** — new `StoreEditor` facade plus four
`MutablePropertyView` extensions: positional-attribute mutations, overlay
entity creation/deletion (with watermark seeding), and three helpers used by
the viewer's undo/redo (`removePositionalMutation`, `restoreFromTombstone`,
`restoreNewEntity`).

**`@ifc-lite/create`** — new `in-store/` module: `addColumnToStore` builds a
12-entity IfcColumn sub-graph (placement, profile, extruded solid,
representation, product shape, rel-contained-in-spatial-structure) anchored
to a target `IfcBuildingStorey`. `resolveSpatialAnchor` walks the parsed
store to find the IfcOwnerHistory, the 'Body' representation context, and
the storey's local placement.

**`@ifc-lite/sdk`** — new `StoreNamespace` exposed as `bim.store` on
`BimContext`. Methods: `addEntity`, `removeEntity`, `setPositionalAttribute`,
`addColumn`. Backed by `StoreBackendMethods` on `BimBackend`; the
`RemoteBackend` proxy round-trips them through the transport.

**`@ifc-lite/sandbox`** — `bim.store.*` is bridged into the QuickJS sandbox
with full TypeScript types via `bim-globals.d.ts` and an LLM cheat sheet in
the system prompt. Gated on a new `store: true` permission (default
`false`, mirrors the existing `mutate` permission pattern).

**`@ifc-lite/cli`** — `HeadlessBackend.store` is now functional (was a
no-op before). Scripts run via the CLI can edit a parsed model and export it
with mutations applied.

**`@ifc-lite/viewer`** — three new UI surfaces:
  - Raw STEP tab in `PropertiesPanel` — lists every positional STEP argument
    with an inline pen-icon editor for scalar values (numbers, refs, enums,
    null). Mutated rows show a purple dot and tinted background.
  - `EntityContextMenu` gains "Delete entity" (red, calls `removeEntity`
    with toast + undo support) and "Add column here…" (emerald, only enabled
    when the right-clicked entity is an `IfcBuildingStorey`).
  - `AddColumnDialog` modal — storey picker sorted by elevation, position
    (storey-local metres), cross-section, height, name, optional collapsible
    for Description/ObjectType/Tag. Anchor-resolution failures surface
    inline, not as thrown exceptions.

Plus four new actions on `mutationSlice` (`setPositionalAttribute`,
`removeEntity`, `addColumn`, dialog open/close) backed by per-model
`StoreEditor` caches, with undo/redo wired for `UPDATE_POSITIONAL_ATTRIBUTE`,
`CREATE_ENTITY`, and `DELETE_ENTITY`.

**`@ifc-lite/parser`** — `package.json` `exports` re-ordered to put `types`
before `import` so downstream consumers using TS5 `nodenext` resolution
pick up the type declarations.

**`@ifc-lite/geometry`** — re-exports `MetadataBootstrapEntitySummary` and
`MetadataBootstrapSpatialNode` from the package index (used by viewer
desktop services).

**`@ifc-lite/renderer`** — `GPUBufferDescriptor` ambient declaration gains
`mappedAtCreation?: boolean`. Internal change; the renderer was already
using it at runtime to skip a Mojo IPC round-trip on Chrome/Dawn.
