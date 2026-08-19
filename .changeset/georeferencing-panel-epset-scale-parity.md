---
"@ifc-lite/viewer": patch
---

Fix the Georeferencing panel's double-georeference banner reading the wrong scale for IFC2x3 `ePSet_MapConversion` files with no explicit ePset `MapUnit` — a 1000x scale error for millimetre projects.

`getEffectiveGeoreference` (`effective-georef.ts`) resolves this case via `resolveEpsetMapUnitScale`: when an ePSet-sourced georeference has no explicit `MapUnit`, its offsets are in the project length unit per the buildingSMART convention, not metres. Every other consumer of the georeference — `ViewportContainer`, `BasepointOverlay`, `FederationAlignmentControls`, `federationAlign.ts`, `useAnchorGeoreference.ts` — reaches that fix by calling `getEffectiveGeoreference`.

`GeoreferencingPanel.tsx` built its `mergedCRS` from `mergeProjectedCRS` alone, fed by `ModelMetadataPanel.tsx`'s own direct `extractGeoreferencingOnDemand` call rather than `getEffectiveGeoreference`. For an ePSet-sourced file with no explicit MapUnit this left `mapUnitScale` `undefined`, which `resolveMapUnitToMetreScale` reads as "treat offsets as metres" — the panel's `detectDoubleGeoreference` check then scaled a millimetre project's eastings/northings by 1 instead of 0.001, a 1000x error in the reported residual/displacement.

`mergedCRS` now applies `resolveEpsetMapUnitScale` after `mergeProjectedCRS`, matching `getEffectiveGeoreference`'s composition exactly.
