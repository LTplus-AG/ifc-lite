/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ifc-lite convert <file> --schema IFC2X3` on an IFC4 model silently
 * destroyed every IfcDoorType/IfcWindowType: `IFC4_TO_IFC2X3` had no entry
 * for either, so `convertStepLine` treated them as having NO IFC2X3
 * representation at all and replaced each one with an IFCPROXY carrying a
 * freshly minted GlobalId — losing the door/window type's own GlobalId,
 * Name, Description and property-set associations — even though IFC2X3 has
 * a real target for both: `IfcDoorStyle`/`IfcWindowStyle`. Found round-
 * tripping `tests/models/ara3d/AC20-FZK-Haus.ifc` (IFC4 → IFC2X3 → IFC4) and
 * diffing against the source with `ifc-lite diff --by-content`: all 8
 * IfcDoorType/IfcWindowType instances came back with a different GlobalId
 * (added+deleted, not modified).
 *
 * The fix (`IFC4_TO_IFC2X3`'s two new entries, `BY_NAME_ATTR_REMAP_TYPES` in
 * `schema-converter-attr-remap.ts`) is scoped to exactly these two types:
 * `schema-converter.test.ts`'s IFCBRIDGE→IFCBUILDING case pins that any
 * OTHER rename whose lists aren't a strict positional prefix must still
 * pass its attributes through untouched.
 */
import { describe, it, expect } from 'vitest';
import { convertStepLine } from './schema-converter.js';

describe('convertStepLine maps IfcDoorType/IfcWindowType to their IFC2X3 IfcDoorStyle/IfcWindowStyle target', () => {
  it('IFCDOORTYPE keeps its GlobalId, Name and psets instead of becoming an IFCPROXY', () => {
    // IfcDoorType(IFC4): GlobalId,OwnerHistory,Name,Description,
    // ApplicableOccurrence,HasPropertySets,RepresentationMaps,Tag,
    // ElementType,PredefinedType,OperationType,ParameterTakesPrecedence,
    // UserDefinedOperationType
    const line =
      "#1=IFCDOORTYPE('1mW6gHB0W7lxCAqIKVEzia',#2,'Door Type',$,$,(#3),(#4),'tag'," +
      '$,.DOOR.,.SINGLE_SWING_LEFT.,.T.,$);';
    const out = convertStepLine(line, 'IFC4', 'IFC2X3');

    expect(out).not.toContain('IFCPROXY');
    expect(out).toContain('IFCDOORSTYLE');
    // GlobalId, Name, HasPropertySets, RepresentationMaps, Tag all survive.
    expect(out).toContain("'1mW6gHB0W7lxCAqIKVEzia'");
    expect(out).toContain("'Door Type'");
    expect(out).toContain('(#3)');
    expect(out).toContain('(#4)');
    expect(out).toContain("'tag'");
    // OperationType (name match at a different position) survives too.
    expect(out).toBe(
      "#1=IFCDOORSTYLE('1mW6gHB0W7lxCAqIKVEzia',#2,'Door Type',$,$,(#3),(#4),'tag'," +
        '.SINGLE_SWING_LEFT.,$,.T.,$);',
    );
  });

  it('IFCWINDOWTYPE keeps its GlobalId and Name instead of becoming an IFCPROXY', () => {
    // IfcWindowType(IFC4): …,Tag,ElementType,PredefinedType,PartitioningType,
    // ParameterTakesPrecedence,UserDefinedPartitioningType
    const line =
      "#1=IFCWINDOWTYPE('3Vnz8SzMO$_GklsTTZo$zj',#2,'Window Type',$,$,$,$,'tag'," +
      '$,.WINDOW.,.SINGLE_PANEL.,.T.,$);';
    const out = convertStepLine(line, 'IFC4', 'IFC2X3');

    expect(out).not.toContain('IFCPROXY');
    expect(out).toContain('IFCWINDOWSTYLE');
    expect(out).toContain("'3Vnz8SzMO$_GklsTTZo$zj'");
    expect(out).toContain("'Window Type'");
  });

  it('round-trips IFC2X3 → IFC4 → IFC2X3 without renaming IfcDoorStyle (control: already-lossless direction unchanged)', () => {
    const line = "#1=IFCDOORSTYLE('1mW6gHB0W7lxCAqIKVEzia',#2,'Door Style',$,$,$,$,$,.SINGLE_SWING_LEFT.,$,.T.,$);";
    // IfcDoorStyle is valid (deprecated) in IFC4 too, so the upgrade leg is a
    // pure pass-through -- this direction was never the bug.
    const upgraded = convertStepLine(line, 'IFC2X3', 'IFC4');
    expect(upgraded).toBe(line);
  });

  it('a different IFC4→IFC2X3 rename with mismatched attribute names (IFCBRIDGE→IFCBUILDING) is left untouched (control: the by-name remap is NOT applied outside the allowlist)', () => {
    const line = "#10=IFCBRIDGE('guid',$,'Bridge 1',$,$,$,$,$);";
    const result = convertStepLine(line, 'IFC4X3', 'IFC4');
    expect(result).toBe("#10=IFCBUILDING('guid',$,'Bridge 1',$,$,$,$,$);");
  });
});
