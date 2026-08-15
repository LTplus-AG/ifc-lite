/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The GlobalId-uniqueness rule over classes the IFC4 codegen pin does not
 * carry (#2003).
 *
 * The rule only looks at types whose inheritance chain reaches `IfcRoot`, and
 * that chain used to come from the parser's IFC4_ADD2_TC1 pin alone. For the 39
 * IFC2X3 `IfcRoot` classes the pin has no row for — `IfcScheduleTimeControl`,
 * `IfcSpaceProgram`, `IfcServiceLife`, `IfcMove`, `IfcOrderAction`,
 * `IfcTimeSeriesSchedule`, … — the chain came back empty, the type was skipped,
 * and the file was reported clean on identity without having been looked at.
 *
 * The chain check is not decoration, so the excluded half is tested too: the
 * columnar parser fills slot 0 of a *resource* record with its Name, so
 * dropping the check would report two same-named `IfcMaterial`s as a duplicate
 * GlobalId.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { computeValidationIssues } from './validate.js';

function buildIfc(schema: string, dataLines: string[]): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
    `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;',
    'DATA;',
    ...dataLines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

async function parse(content: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(content);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new IfcParser().parseColumnar(buffer);
}

/** IfcProject / IfcSite / IfcBuilding, so the file's other rules stay quiet. */
const PREAMBLE_2X3 = [
  "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);",
  "#2=IFCSITE('0Site_GUID_00000001',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);",
  "#3=IFCBUILDING('0Bldg_GUID_00000001',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);",
  "#4=IFCBUILDINGSTOREY('0Storey_GUID_000001',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);",
];

function duplicateIds(issues: ReturnType<typeof computeValidationIssues>): string[] {
  return issues.filter((i) => i.rule === 'unique-globalid').map((i) => i.message);
}

describe('unique-globalid across every bundled schema', () => {
  it('catches a duplicate on an IFC2X3 class the IFC4 pin does not carry', async () => {
    const store = await parse(buildIfc('IFC2X3', [
      ...PREAMBLE_2X3,
      // IfcScheduleTimeControl is IfcControl → IfcObject → IfcRoot in IFC2X3 and
      // was dropped from IFC4 entirely, so the pinned registry answers [].
      "#50=IFCSCHEDULETIMECONTROL('0Dupe_GUID_00000001',$,'Ctrl A',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);",
      "#51=IFCSCHEDULETIMECONTROL('0Dupe_GUID_00000001',$,'Ctrl B',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);",
    ]));

    expect(duplicateIds(computeValidationIssues(store))).toEqual(['1 duplicate GlobalId(s) found']);
  });

  it('catches one on an IFC4X3 class the pin does not carry either', async () => {
    const store = await parse(buildIfc('IFC4X3', [
      "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);",
      "#2=IFCSITE('0Site_GUID_00000001',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);",
      "#3=IFCBUILDING('0Bldg_GUID_00000001',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);",
      "#4=IFCBUILDINGSTOREY('0Storey_GUID_000001',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);",
      // IfcCourse is an IFC4X3 IfcBuiltElement; the pin is on IFC4_ADD2_TC1.
      "#60=IFCCOURSE('0Dupe_GUID_00000002',$,'Course A',$,$,$,$,$,$);",
      "#61=IFCCOURSE('0Dupe_GUID_00000002',$,'Course B',$,$,$,$,$,$);",
    ]));

    expect(duplicateIds(computeValidationIssues(store))).toEqual(['1 duplicate GlobalId(s) found']);
  });

  it('still catches the IFC4 case the pin always answered', async () => {
    const store = await parse(buildIfc('IFC4', [
      "#1=IFCPROJECT('0Project_GUID_000001',$,'Project',$,$,$,$,$,$);",
      "#2=IFCSITE('0Site_GUID_00000001',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);",
      "#3=IFCBUILDING('0Bldg_GUID_00000001',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);",
      "#4=IFCBUILDINGSTOREY('0Storey_GUID_000001',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);",
      "#10=IFCWALL('0Dupe_GUID_00000003',$,'Wall A',$,$,$,$,$,$);",
      "#11=IFCWALL('0Dupe_GUID_00000003',$,'Wall B',$,$,$,$,$,$);",
    ]));

    expect(duplicateIds(computeValidationIssues(store))).toEqual(['1 duplicate GlobalId(s) found']);
  });

  it('stays quiet on the clean IFC2X3 twin', async () => {
    const store = await parse(buildIfc('IFC2X3', [
      ...PREAMBLE_2X3,
      "#50=IFCSCHEDULETIMECONTROL('0Ctrl_GUID_00000001',$,'Ctrl A',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);",
      "#51=IFCSCHEDULETIMECONTROL('0Ctrl_GUID_00000002',$,'Ctrl B',$,$,$,$,$,$,$,$,$,$,$,$,$,$,$,$);",
    ]));

    expect(duplicateIds(computeValidationIssues(store))).toEqual([]);
  });

  it('does not mistake two same-named resource entities for a duplicate GlobalId', async () => {
    // `IfcMaterial` and `IfcSurfaceStyle` are not IfcRoot subtypes in any
    // schema, and the columnar parser keys them on the Name in slot 0 — so this
    // is what the chain check buys. It fails the moment the check is widened to
    // "every type" instead of "every IfcRoot type".
    const store = await parse(buildIfc('IFC2X3', [
      ...PREAMBLE_2X3,
      "#60=IFCMATERIAL('Concrete');",
      "#61=IFCMATERIAL('Concrete');",
      "#62=IFCSURFACESTYLE('Shared',.BOTH.,());",
      "#63=IFCSURFACESTYLE('Shared',.BOTH.,());",
    ]));

    expect(duplicateIds(computeValidationIssues(store))).toEqual([]);
  });
});
