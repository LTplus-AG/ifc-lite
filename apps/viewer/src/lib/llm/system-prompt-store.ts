/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `bim.store` cheat sheet section of the LLM system prompt. Split out of
 * `system-prompt.ts` (allowlisted, at its size budget) so the builder list can
 * grow with the in-store authoring surface.
 */

import { NAMESPACE_SCHEMAS } from '@ifc-lite/sandbox/schema';

export function buildStoreCheatSheet(): string {
  const storeNamespace = NAMESPACE_SCHEMAS.find((schema) => schema.name === 'store');
  if (!storeNamespace) return '';

  return [
    '## BIM.STORE CHEAT SHEET',
    '`bim.store.*` edits a parsed model in place — use it when the user already has',
    'a model loaded and wants raw STEP-level edits, NOT when building a new model from',
    'scratch (that\'s `bim.create`).',
    '',
    '- `addEntity(modelId, { type, attributes })` — inject a STEP entity. `attributes`',
    '  follows EntityExtractor output: numbers → REAL/integer, `"#42"` → ref, `".AREA."` → enum,',
    '  `null` → `$`, arrays → STEP list. Returns `{ modelId, expressId }`.',
    '- `removeEntity(entity)` — tombstones existing source entities or forgets overlay-only ones.',
    '- `setPositionalAttribute(entity, index, value)` — edit a non-IfcRoot attribute by',
    '  zero-based STEP argument index. Use this for `IfcRectangleProfileDef.XDim` (index 3),',
    '  `YDim` (index 4), `IfcCartesianPoint.Coordinates` (index 0), etc. Use `bim.mutate.setAttribute`',
    '  for IfcRoot attributes (Name, Description, ObjectType, Tag).',
    '- High-level builders anchor a new element to an existing IfcBuildingStorey:',
    '    `addColumn(modelId, storeyId, { Position, Width, Depth, Height })`',
    '    `addWall(modelId, storeyId, { Start, End, Thickness, Height })`',
    '    `addBeam(modelId, storeyId, { Start, End, Width, Height })`',
    '    `addSlab(modelId, storeyId, { Position, Width, Depth, Thickness })`             // rectangle',
    '    `addSlab(modelId, storeyId, { Profile: "polygon", OuterCurve: [[x,y],…], Thickness })`',
    '    `addRoof(modelId, storeyId, { … same shape as addSlab — emits .FLAT_ROOF. })`',
    '    `addPlate(modelId, storeyId, { … same shape as addSlab — IfcPlate, PredefinedType? })`',
    '    `addSpace(modelId, storeyId, { Position, Width, Depth, Height, LongName? })`     // room rectangle',
    '    `addSpace(modelId, storeyId, { Profile: "polygon", OuterCurve, Height })`        // room polygon',
    '    `addDoor(modelId, storeyId, { Position, Width, Height, FrameThickness?, OperationType? })`',
    '    `addWindow(modelId, storeyId, { Position, Width, Height, FrameThickness?, PartitioningType? })`',
    '    `addMember(modelId, storeyId, { Start, End, Width, Height, PredefinedType? })`   // brace/post/strut',
    '  Each emits ~12 STEP entities (placement chain → profile → solid → representation +',
    '  IfcRelContainedInSpatialStructure, except `addSpace` which uses IfcRelAggregates).',
    '  Coords are storey-local metres. Polygon outlines need ≥3 points; the polyline is auto-closed.',
    '- Hosted builders cut into an existing IfcWall/IfcSlab (hostId, not storeyId; metres in the host frame):',
    '    `addOpening(modelId, hostId, { Offset, Sill?, Width, Height })`                  // wall; slab: { Position: [x,y], Width, Depth }',
    '    `addHostedDoor(modelId, hostId, { Offset, Width, Height, Sill?, OperationType? })`',
    '    `addHostedWindow(modelId, hostId, { Offset, Sill, Width, Height, PartitioningType? })`',
    '- Edits accumulate in an overlay; they show up after `bim.export.ifc()` (no argument: the whole model)',
    '  or when the viewer next renders. Use `bim.mutate.undo(modelId)` to roll back.',
    '',
    'Canonical examples:',
    '```js',
    '// Resize a rectangular profile from 0.3×0.4 to 0.6×0.4',
    'const profile = bim.query.byId("arch", 35);',
    'bim.store.setPositionalAttribute(profile, 3, 0.6);   // XDim',
    '',
    '// Drop a wall on the first storey',
    'const storeyId = bim.query.byType("IfcBuildingStorey")[0].ref.expressId;',
    'bim.store.addWall("arch", storeyId, {',
    '  Start: [0, 0, 0], End: [5, 0, 0],',
    '  Thickness: 0.2, Height: 3, Name: "North Wall",',
    '});',
    '',
    '// Add a custom IfcCartesianPoint, then reference it from another entity',
    'const pt = bim.store.addEntity("arch", {',
    '  type: "IfcCartesianPoint",',
    '  attributes: [[1.0, 2.0, 0.0]],',
    '});',
    'console.log("Allocated", pt.expressId);',
    '',
    '// Drop an entity entirely',
    'bim.store.removeEntity(unwantedRef);',
    '```',
  ].join('\n');
}
