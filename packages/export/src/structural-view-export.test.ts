/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { tableFromIPC } from 'apache-arrow';
import { readParquet } from 'parquet-wasm';
import { ParquetExporter } from './parquet-exporter.js';
import { Ifc5Exporter } from './ifc5-exporter.js';
import { StepExporter } from './step-exporter.js';
import { effectiveCreatedRecord } from './effective-source-record.js';
import { remeshContextRoots } from './remesh-context-roots.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#2=IFCBUILDING('0000000000000000000002',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#3=IFCWALL('0000000000000000000003',$,'Source wall',$,$,$,$,$,$);
#4=IFCRELAGGREGATES('0000000000000000000004',$,$,$,#1,(#2));
ENDSEC;END-ISO-10303-21;`;

async function fixture() {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer);
  const view = new MutablePropertyView(null, 'structural');
  const editor = new StoreEditor(store, view);
  const wall = editor.addEntity('IfcWall', ['0000000000000000000005', null, 'Authored wall', null, null, null, null, null, null]).expressId;
  const relation = editor.addEntity('IfcRelAggregates', ['0000000000000000000006', null, null, null, '#2', [`#${wall}`]]).expressId;
  view.setAttribute(wall, 'Name', 'Edited wall');
  // #9411: structural integrations predate both read-only borrow methods.
  const legacy = new Proxy(view, { get(target, key, receiver) {
    return key === 'readNewEntities' || key === 'readNewEntity' ? undefined : Reflect.get(target, key, receiver);
  } });
  return { store, view, legacy, editor, wall, relation };
}

function decode(bytes: Uint8Array): Record<string, unknown>[] {
  return tableFromIPC(readParquet(bytes).intoIPCStream()).toArray().map(row => row.toJSON());
}

it('#9411 Parquet entities retain authored edits through a structural view', async () => {
  const { store, legacy, wall } = await fixture();
  const rows = decode(await new ParquetExporter(store, undefined, legacy).exportTable('entities'));
  expect(rows.find(row => row.ExpressId === wall)).toMatchObject({ Name: 'Edited wall', Type: 'IfcWall' });
});

it('#9411 Parquet relationships retain authored edges through a structural view', async () => {
  const { store, legacy, wall, relation } = await fixture();
  const rows = decode(await new ParquetExporter(store, undefined, legacy).exportTable('relationships'));
  expect(rows).toContainEqual({ SourceId: 2, TargetId: wall, RelType: 'IfcRelAggregates', RelId: relation });
});

it('#9411 IFC5 keeps structural-view creations in the spatial tree', async () => {
  const { store, legacy } = await fixture();
  const result = new Ifc5Exporter(store, undefined, legacy).export({ includeGeometry: false });
  expect(result.content).toContain('Edited wall');
});

it('#9411 remesh context retains authored void relationships through a structural view', async () => {
  const { store, legacy, editor, wall } = await fixture();
  const opening = editor.addEntity('IfcOpeningElement', ['0000000000000000000007', null, 'Opening', null, null, null, null, null, null]).expressId;
  const voids = editor.addEntity('IfcRelVoidsElement', ['0000000000000000000008', null, null, null, `#${wall}`, `#${opening}`]).expressId;
  const roots = remeshContextRoots(store, legacy, new Set([wall]));
  expect(roots.has(opening)).toBe(true);
  expect(roots.has(voids)).toBe(true);
});

it('#9411 effective created records use the original structural point getter', async () => {
  const { store, legacy, wall } = await fixture();
  expect(effectiveCreatedRecord(legacy, wall, store.schemaVersion)?.text).toContain("'Edited wall'");
});

it('#9411 STEP property-set reads support structural views missing both borrows', async () => {
  const { store, view, legacy, wall } = await fixture();
  view.setProperty(wall, 'Pset_WallCommon', 'IsExternal', true);
  const result = new StepExporter(store, legacy).export({ schema: 'IFC4', applyMutations: true });
  expect(new TextDecoder().decode(result.content)).toContain("IFCPROPERTYSINGLEVALUE('IsExternal'");
});
