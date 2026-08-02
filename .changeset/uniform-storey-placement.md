---
'@ifc-lite/create': major
'@ifc-lite/sdk': major
'@ifc-lite/sandbox': major
'@ifc-lite/cli': minor
'@ifc-lite/mcp': minor
---

**BREAKING:** every `IfcCreator` element constructor now places its product relative to the storey it is added to. Element coordinates are storey-relative across the whole API.

## What was wrong

`IfcCreator` chained the product's `IfcLocalPlacement` to a different parent depending on which method you called. Seven methods — `addIfcWall`, `addIfcSlab`, `addIfcColumn`, `addIfcBeam`, `addIfcStair`, `addIfcRoof`, `addIfcGableRoof` — chained to the storey placement, which carries `[0, 0, Elevation]`. The other 21 — `addIfcDoor`, `addIfcWindow`, `addIfcRamp`, `addIfcRailing`, `addIfcPlate`, `addIfcMember`, `addIfcFooting`, `addIfcPile`, `addIfcSpace`, `addIfcCurtainWall`, `addIfcFurnishingElement`, `addIfcBuildingElementProxy`, `addIfcCircularColumn`, `addIfcIShapeBeam`, `addIfcLShapeMember`, `addIfcTShapeMember`, `addIfcUShapeMember`, `addIfcHollowCircularColumn`, `addIfcRectangleHollowBeam`, `addElement`, `addAxisElement` — chained to the world.

On a storey with a non-zero `Elevation`, a caller mixing the two families got two datums in one model, with no error and nothing downstream to notice. Measured on a real scan-to-IFC run: the storey and its spaces at −1.368653 m, the walls at −2.737307 m — exactly 2 × the elevation, standing 1.37 m below the spaces they bounded.

Every one of these methods already took the storey as its first argument and already emitted an `IfcRelContainedInSpatialStructure` into it. Only the placement disagreed.

## Why storey-relative, and not world-relative

The placement hierarchy has to agree with the containment hierarchy. A product contained in a storey whose placement chains past that storey to the world is not a coherent IFC product: moving the storey leaves its own contents behind, and `IfcBuildingStorey.Elevation` and the storey's `ObjectPlacement` become decoration that no geometry honours. The world-relative alternative would have meant deleting the storey's `[0, 0, Elevation]` placement or leaving it as a transform nothing chains to — the wrong half of the schema to surrender.

It is also what the rest of this package already did: the `*ToStore` builders (`addWallToStore`, `addSpaceToStore`, `addDoorToStore`, …) have always chained from `anchor.storeyPlacementId`. Choosing world would have split `@ifc-lite/create` against itself.

## Migrating

If your storeys all have `Elevation: 0`, nothing moves — the storey placement is the identity and the two parents were already the same point.

Otherwise, for the 21 methods listed above: **stop adding the storey elevation to element coordinates.** Pass the height above that storey's floor.

```ts
const storey = creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 3.2 });

// before — absolute Z, because addIfcSpace ignored the storey
creator.addIfcSpace(storey, { Position: [0, 0, 3.2], Width: 4, Depth: 4, Height: 2.6 });

// after — storey-relative Z, like addIfcWall always was
creator.addIfcSpace(storey, { Position: [0, 0, 0], Width: 4, Depth: 4, Height: 2.6 });
```

If you compensated for the asymmetry — passing absolute Z to the world-parented methods and storey-relative Z to the storey-parented ones, so the two families lined up — remove the compensation from the world-parented calls only. The storey-parented calls were already correct and must not change. A caller that had settled on `Z = 0` for walls and `Z = elevation` for spaces now passes `Z = 0` to both.

`addIfcWallDoor` and `addIfcWallWindow` are unaffected: they were and remain wall-local, and inherit the storey datum through their host.

Also in this release: `getStoreyPlacement` throws `Unknown storeyId #N` instead of silently falling back to the world placement. This is a strictly earlier version of the error `trackElement` already threw a few lines later, so no working call changes — it just means a bogus storey id no longer emits orphan placement entities before failing.

## `@ifc-lite/sandbox`

The `llmSemantics.placement` metadata in `NAMESPACE_SCHEMAS` is corrected to match: the seven methods previously tagged `'world'` (`addIfcMember`, `addIfcPlate`, `addIfcCurtainWall`, `addIfcRailing`, `addIfcDoor`, `addIfcWindow`, `addAxisElement`) are now `'storey-relative'`, and the `useWhen`/`cautions` prose that described them as world-placement is rewritten. The `MethodPlacementKind` union is unchanged and no export was added or removed. Consumers that read `placement` to generate guidance will see different values for those seven methods — which is the point: the old values now describe behaviour that no longer exists.

Thirteen constructors that carried no `llmSemantics` at all — `addIfcRamp`, `addIfcFooting`, `addIfcPile`, `addIfcSpace`, `addIfcFurnishingElement`, `addIfcBuildingElementProxy`, `addIfcCircularColumn`, `addIfcHollowCircularColumn`, `addIfcIShapeBeam`, `addIfcLShapeMember`, `addIfcTShapeMember`, `addIfcUShapeMember`, `addIfcRectangleHollowBeam` — now declare `placement: 'storey-relative'` with their coordinate keys. They were invisible to every consumer that groups methods by placement frame, so nothing generated from this schema said which datum their coordinates were in. `NAMESPACE_SCHEMAS.create` now tags all 30 coordinate-taking constructors (27 storey-relative, `addElement` explicit-placement, and the two wall-local hosted inserts).

## Downstream packages carrying the break

The behaviour change is not confined to `@ifc-lite/create`: three packages re-expose `IfcCreator` and therefore ship it to their own consumers. Each is versioned to say so, rather than letting a caller pick the change up through a range they believed was compatible.

- **`@ifc-lite/sdk` (major)** — re-exports the class directly (`packages/sdk/src/index.ts`: `export { IfcCreator } from '@ifc-lite/create'`). Without a major, a consumer on `^1.21` accepts the release and gets storey-relative placement with no signal.
- **`@ifc-lite/sandbox` (major, was minor)** — `buildCreateMethods()` auto-discovers `IfcCreator.prototype` and dispatches to it, so every affected constructor is reachable from sandbox scripts. A script passing absolute coordinates against a non-zero-elevation storey now emits geometry one elevation off. That is breaking for the script author even though the sandbox's own surface is unchanged.
- **`@ifc-lite/cli` (minor)** — `create` constructs `IfcCreator` and passes `--elevation` straight through, so the same shift reaches CLI users following the previous absolute-coordinate convention. Minor rather than major because the package is pre-1.0, where the house rule maps a breaking change to a minor bump.
- **`@ifc-lite/mcp` (minor)** — exposure is indirect but real: `loadIfcModel()` (`src/index.ts`) returns a `LoadedModel` carrying `bim: BimContext` (`src/loader.ts`), whose `create` namespace constructs the class (`@ifc-lite/sdk` `namespaces/create.ts`: `project()` returns `new IfcCreator(params)`, `building()` takes a `StoreyElevation`). A library consumer calling `model.bim.create.building({ StoreyElevation })` gets the new datum. Minor for the same pre-1.0 reason as the CLI.

`@ifc-lite/wasm` is unaffected — it neither constructs nor re-exports `IfcCreator`, directly or through a namespace. The viewer apps are private and unpublished.
