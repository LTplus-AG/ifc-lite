/* SPDX-License-Identifier: MPL-2.0 */
/**
 * #11326: IFC2X3 IfcMove and IfcOrderAction are written as IfcTask on an upgrade, and
 * their own attributes have no IfcTask slot. The loss report names one only when the
 * source record populated it; an unset (`$`) slot lost nothing.
 */
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { analyzeConversionLoss } from './schema-conversion-loss-report.js';

const parse = (data: string) => new IfcParser().parseColumnar(new TextEncoder().encode(
  `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('t.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC2X3'));\nENDSEC;\nDATA;${data}ENDSEC;\nEND-ISO-10303-21;\n`).buffer as ArrayBuffer);

// IfcTask head (10 slots) then IfcMove's MoveFrom, MoveTo, PunchList.
const move = (id: number, from: string, to: string, punch: string) =>
  `#${id}=IFCMOVE('0DvctVUKr0kugbFTf53O${id}',$,'M',$,$,'T',$,$,.F.,1,${from},${to},${punch});\n`;
// IfcTask head then IfcOrderAction's ActionID.
const order = (id: number, action: string) =>
  `#${id}=IFCORDERACTION('0EvctVUKr0kugbFTf53O${id}',$,'O',$,$,'T',$,$,.F.,1,${action});\n`;

const entry = async (data: string, type: string) =>
  analyzeConversionLoss(await parse(data), 'IFC2X3', 'IFC4').entries.find((e) => e.sourceType === type);

describe('an upgraded IfcMove / IfcOrderAction reports only what the record populated (#11326)', () => {
  it('reports nothing for records whose own slots are all unset', async () => {
    const report = analyzeConversionLoss(await parse(move(1, '$', '$', '$') + order(2, '$')), 'IFC2X3', 'IFC4');
    expect(report.entries).toEqual([]);
    expect(report.hasLoss).toBe(false);
  });

  it('reports exactly the populated slot', async () => {
    expect(await entry(move(1, '#9', '$', '$'), 'IFCMOVE')).toMatchObject({ droppedAttributes: ['MoveFrom'], expressIds: [1] });
    expect(await entry(move(1, '$', '#9', '$'), 'IFCMOVE')).toMatchObject({ droppedAttributes: ['MoveTo'], expressIds: [1] });
    expect(await entry(move(1, '$', '$', "('pack')"), 'IFCMOVE')).toMatchObject({ droppedAttributes: ['PunchList'], expressIds: [1] });
    expect(await entry(order(1, "'A-1'"), 'IFCORDERACTION')).toMatchObject({ droppedAttributes: ['ActionID'], expressIds: [1] });
  });

  it('groups mixed records by what each one populated, leaving out the clean ones', async () => {
    const data = move(1, '#9', '#9', '$') + move(2, '$', '$', '$') + move(3, '$', '#9', "('p')") + order(4, '$') + order(5, "'A'");
    const moves = await entry(data, 'IFCMOVE');
    expect(moves).toMatchObject({ count: 2, expressIds: [1, 3], droppedAttributes: ['MoveFrom', 'MoveTo', 'PunchList'] });
    expect(moves?.recordGroups).toEqual([
      { droppedAttributes: ['MoveFrom', 'MoveTo'], count: 1, expressIds: [1] },
      { droppedAttributes: ['MoveTo', 'PunchList'], count: 1, expressIds: [3] },
    ]);
    expect(await entry(data, 'IFCORDERACTION')).toMatchObject({ count: 1, expressIds: [5], droppedAttributes: ['ActionID'] });
  });
});
