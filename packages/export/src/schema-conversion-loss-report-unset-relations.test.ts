/* SPDX-License-Identifier: MPL-2.0 */
/**
 * #11326: a type IFC4 deleted is written as its IFC4 supertype whether or not an attribute
 * map exists for it, and an unset (`$`) own attribute lost nothing. `()` and `''` are values.
 */
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';

const parse = (data: string) => new IfcParser().parseColumnar(new TextEncoder().encode(
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;${data}ENDSEC;\nEND-ISO-10303-21;\n`).buffer as ArrayBuffer);

const GUID = '0FvctVUKr0kugbFTf53O9L';
// IfcRelAssignsTasks: head, RelatedObjects, RelatedObjectsType, RelatingControl, TimeForTask.
const tasks = (time: string) => `#8=IFCRELASSIGNSTASKS('${GUID}',$,$,$,(#5),$,#9,${time});\n`;
// IfcWorkPlan: its last slot is UserDefinedControlType.
const plan = (userDefined: string) =>
  `#9=IFCWORKPLAN('${GUID}',$,'Plan',$,$,'WP1',$,$,$,$,$,$,$,$,${userDefined});\n`;

const entry = async (data: string, type: string) =>
  analyzeConversionLoss(await parse(data), 'IFC2X3', 'IFC4').entries.find((e) => e.sourceType === type);

describe('an upgraded IFCREL* subtype without an attribute map reports only populated slots (#11326)', () => {
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
