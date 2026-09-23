/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { Ifc5Exporter } from './ifc5-exporter.js';

const MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('effective.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCPROJECT('0GUID00000000000000010',$,'Project',$,$,$,$,$,$);
#20=IFCWALL('0GUID00000000000000020',$,'Deleted Wall',$,$,$,$,$);
#30=IFCWALL('0GUID00000000000000030',$,'Retyped Wall',$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

interface Node { path: string; attributes?: Record<string, unknown>; children?: Record<string, string | null> }
const nodes = (content: string): Node[] => (JSON.parse(content) as { data: Node[] }).data;
const named = (data: Node[], name: string): Node | undefined =>
  data.find((node) => node.attributes?.['bsi::ifc::prop::Name'] === name);

describe('IFC5 effective entity enumeration (#5249)', () => {
  it('emits created and retyped nodes, omits tombstones, and applies visibility to creates', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(MODEL).buffer);
    const view = new MutablePropertyView(null, 'ifc5-effective');
    const editor = new StoreEditor(store, view);
    const created = editor.addEntity('IfcWall', ['0GUID00000000000000040', null, 'New Wall', null, null, null, null, null]);
    editor.addEntity('IfcRelAggregates', ['0GUID00000000000000050', null, null, null, '#10', [`#${created.expressId}`]]);
    editor.setAttribute(created.expressId, 'Name', 'Edited Wall');
    expect(editor.setEntityType(30, 'IfcDoor')).toBe(true);
    editor.setAttribute(30, 'Name', 'Edited Door');
    view.deleteEntity(20);

    const exporter = new Ifc5Exporter(store, null, view);
    const live = nodes(exporter.export({ onlyTreeEntities: false, visibleOnly: true }).content);
    expect(named(live, 'Deleted Wall')).toBeUndefined();
    expect(named(live, 'Edited Wall')?.path).toBe('0GUID00000000000000040');
    expect(named(live, 'Edited Door')?.attributes?.['bsi::ifc::class']).toMatchObject({ code: 'IfcDoor' });

    const tree = nodes(exporter.export({ includeGeometry: false }).content);
    expect(Object.values(named(tree, 'Project')?.children ?? {})).toContain(named(tree, 'Edited Wall')?.path);

    const hidden = nodes(exporter.export({ onlyTreeEntities: false, visibleOnly: true,
      hiddenEntityIds: new Set([created.expressId]) }).content);
    expect(named(hidden, 'Edited Wall')).toBeUndefined();

    const source = nodes(exporter.export({ onlyTreeEntities: false, applyMutations: false }).content);
    expect(named(source, 'Deleted Wall')).toBeDefined();
    expect(named(source, 'New Wall')).toBeUndefined();
    expect(named(source, 'Retyped Wall')?.attributes?.['bsi::ifc::class']).toMatchObject({ code: 'IfcWall' });
  });
});
