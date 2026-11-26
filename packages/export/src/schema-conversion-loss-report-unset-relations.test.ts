/* SPDX-License-Identifier: MPL-2.0 */
/**
 * #11448: a type-wide drop (a type IFC4 deleted, written as its supertype with or without an
 * attribute map, or a type whose attribute list shrinks either way) loses only the slots a record
 * populated: an unset (`$`) one lost nothing. `()` and `''` are values. As the Rust exporter counts.
 */
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';

const parse = (data: string, schema = 'IFC2X3') => new IfcParser().parseColumnar(new TextEncoder().encode(
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;${data}ENDSEC;\nEND-ISO-10303-21;\n`).buffer as ArrayBuffer);

const GUID = '0FvctVUKr0kugbFTf53O9L';
// IfcRelAssignsTasks: head, RelatedObjects, RelatedObjectsType, RelatingControl, TimeForTask.
const tasks = (time: string) => `#8=IFCRELASSIGNSTASKS('${GUID}',$,$,$,(#5),$,#9,${time});\n`;
// IfcWorkPlan: its last slot is UserDefinedControlType.
const plan = (userDefined: string) =>
  `#9=IFCWORKPLAN('${GUID}',$,'Plan',$,$,'WP1',$,$,$,$,$,$,$,$,${userDefined});\n`;

const entry = async (data: string, type: string) =>
  analyzeConversionLoss(await parse(data), 'IFC2X3', 'IFC4').entries.find((e) => e.sourceType === type);

describe('a type-wide drop without an attribute map reports only populated slots (#11448)', () => {
  it('names nothing for an unset TimeForTask', async () => {
    expect(await entry(tasks('$'), 'IFCRELASSIGNSTASKS')).toBeUndefined();
  });
  it('names TimeForTask when populated, including the empty string', async () => {
    const lost = { kind: 'lossy', droppedAttributes: ['TimeForTask'], expressIds: [8] };
    expect(await entry(tasks("'a'"), 'IFCRELASSIGNSTASKS')).toMatchObject(lost);
    expect(await entry(tasks("''"), 'IFCRELASSIGNSTASKS')).toMatchObject(lost);
  });
  it('names nothing for an unset IfcWorkPlan UserDefinedControlType and names a populated one', async () => {
    expect(await entry(plan('$'), 'IFCWORKPLAN')).toBeUndefined();
    expect(await entry(plan("'X'"), 'IFCWORKPLAN')).toMatchObject({ droppedAttributes: ['UserDefinedControlType'], expressIds: [9] });
  });
});

describe('the unset-slot rule in other directions (#11448)', () => {
  it('names an IFC4 -> IFC2X3 trimmed PredefinedType only when populated', async () => {
    const wall = (predefined: string) => `#7=IFCWALL('${GUID}',$,'W',$,$,$,$,$,${predefined});\n`;
    const down = async (data: string) => analyzeConversionLoss(await parse(data, 'IFC4'), 'IFC4', 'IFC2X3').entries.find((e) => e.sourceType === 'IFCWALL');
    expect(await down(wall('$'))).toBeUndefined();
    expect(await down(wall('.NOTDEFINED.'))).toMatchObject({ droppedAttributes: ['PredefinedType'], expressIds: [7] });
  });
  it('still names a record of a type the target lacks, even when every slot is unset', async () => {
    expect(await entry('#7=IFCRELAXATION($,$);\n', 'IFCRELAXATION')).toMatchObject({ kind: 'lossy', expressIds: [7] });
  });
});
