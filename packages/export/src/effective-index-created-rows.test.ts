// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { borrowedCreatedRows } from './effective-index-created-rows.js';

it('#8452 created-ID enumeration snapshots membership without materializing any attribute payload', () => {
  const view = new MutablePropertyView(null, 'export-ids');
  const a = view.createEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId;
  const b = view.createEntity('IfcCartesianPoint', [[4, 5, 6]]).expressId;
  const all = vi.spyOn(view, 'readNewEntities'), one = vi.spyOn(view, 'readNewEntity');
  try {
    const rows = borrowedCreatedRows(view)!;
    const iterator = rows.keys()[Symbol.iterator]();
    const first = iterator.next();
    view.createEntity('IfcCartesianPoint', [[7, 8, 9]]);
    expect([first.value, ...{ [Symbol.iterator]: () => iterator }]).toEqual([a, b]);
    expect(all).not.toHaveBeenCalled();
    expect(one).not.toHaveBeenCalled();
    expect(rows.get(b)?.attributes).toEqual([[4, 5, 6]]);
  } finally { all.mockRestore(); one.mockRestore(); }
});


it('#8452 created-ID enumeration retains the structural-view compatibility path', () => {
  const view = new MutablePropertyView(null, 'legacy-export-ids');
  const id = view.createEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId;
  const legacy = new Proxy(view, { get(target, key, receiver) {
    return key === 'readNewEntityKinds' ? undefined : Reflect.get(target, key, receiver);
  } });
  expect([...borrowedCreatedRows(legacy)!.keys()]).toEqual([id]);
});


it('#8452 serializes authored records through the shared index without bulk snapshot copies', async () => {
  const bytes = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('points.ifc','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
  const view = new MutablePropertyView(null, 'shared-export-index');
  view.setExpressIdWatermark(1);
  const point = view.createEntity('IfcCartesianPoint', [[1, 2, 3]]);
  const bulk = vi.spyOn(view, 'readNewEntities');
  try {
    const result = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true });
    expect(new TextDecoder().decode(result.content)).toContain(`#${point.expressId}=IFCCARTESIANPOINT((1.,2.,3.));`);
    expect(bulk).not.toHaveBeenCalled();
  } finally { bulk.mockRestore(); }
});

it('#8452 exporting attachment metadata leaves authored arrays unexposed to later transactions', async () => {
  const bytes = new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('metadata.ifc','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer);
  const view = new MutablePropertyView(null, 'attachment-export');
  view.setExpressIdWatermark(1);
  const column = view.createEntity('IfcColumn', ['0000000000000000000002', null, 'Column', null, null, null, null, null, '.COLUMN.']);
  view.setProperty(column.expressId, 'IfcLite_StoreyAttachment', 'TopBinding', 'above');
  const changes = view.trackEntityChanges();
  try {
    expect(changes.take()?.size).toBe(0);
    const options = { schema: 'IFC4' as const, applyMutations: true, timeStamp: '1970-01-01T00:00:00' };
    const exported = new StepExporter(store, view).export(options).content;
    expect(new TextDecoder().decode(exported)).toContain("'IfcLite_StoreyAttachment'");
    expect(changes.take()?.size).toBe(0);
    expect(new StepExporter(store, view).export(options).content).toEqual(exported);
    // Mutable callers still expose their arrays: export must use borrowed reads,
    // rather than suppressing the transaction's alias tracking globally.
    expect(view.getNewEntity(column.expressId)?.attributes[0]).toBe('0000000000000000000002');
    expect([...changes.take() ?? []]).toEqual([column.expressId]);
  } finally { changes.dispose(); }
});
