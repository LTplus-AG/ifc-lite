/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Eval prompts. The model context mirrors what the viewer sends for AC20-FZK-Haus. */

export const MODEL_CONTEXT = `## Loaded models
- modelId "fzk": AC20-FZK-Haus.ifc (IFC4), 2 storeys "Erdgeschoss" and "Dachgeschoss".
  Types present: IfcWall, IfcWallStandardCase, IfcSlab, IfcDoor, IfcWindow, IfcRoof, IfcStair, IfcSpace, IfcBeam, IfcColumn, IfcRailing, IfcMember, IfcCovering.
  Property sets seen: Pset_WallCommon (IsExternal, LoadBearing, FireRating), Pset_DoorCommon (IsExternal, FireRating), Pset_WindowCommon (IsExternal), Pset_SpaceCommon, Qto_SpaceBaseQuantities (NetFloorArea, GrossFloorArea), Qto_WallBaseQuantities (NetVolume, Length).
- Current selection: none.`;

export const CASES = [
  { id: 'doors-no-fire', prompt: 'Which doors have no fire rating? Show them so I can find them in the model.', expectSurface: true, expect: ['EntityTable', 'ActionBar'] },
  { id: 'storey-mix', prompt: 'Give me a chart of how many walls, slabs and windows are on each storey.', expectSurface: true, expect: ['GroupChart'] },
  { id: 'space-areas', prompt: 'List all spaces with their net floor area, biggest first, and total it up.', expectSurface: true, expect: ['EntityTable', 'StatGroup'] },
  { id: 'external-walls', prompt: 'Colour the external walls red and isolate them.', expectSurface: true, expect: ['ActionBar'] },
  { id: 'color-by-type', prompt: 'Colour the model by element type and show me a legend.', expectSurface: true, expect: ['ColorLegend'] },
  { id: 'kpis', prompt: 'Give me a quick overview dashboard of this building: counts of doors, windows, spaces and walls.', expectSurface: true, expect: ['StatGroup'] },
  { id: 'clarify', prompt: 'Check the elements for missing properties.', expectSurface: true, expect: [] },
  { id: 'selection', prompt: 'Tell me everything about what I have selected.', expectSurface: true, expect: ['EntityCard'] },
  { id: 'smalltalk', prompt: 'What does IFC stand for? One sentence.', expectSurface: false, expect: [] },
];
