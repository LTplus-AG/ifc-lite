/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The write-back control, driven from the panel that hosts it (#2508 item 3).
 *
 * `useZoneWriteBack.test.ts` proves the write itself. What this proves is the
 * half that file cannot: the button exists ON the Zones panel, and CLICKING it
 * writes. A test that asserts the control renders would pass just as well with
 * `onClick={() => {}}`, which is the failure #2434 catalogued and #2396 shipped
 * - so the assertion here is the property set landing on the element.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { render, click, cleanup } from '@/test/render.js';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store/index.js';
import { ZonesPanel } from './ZonesPanel.js';
import { zonePropertySetName, type ZoneSet } from '@/lib/zones';

const WALL_ID = 42;

const MINI_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('zones','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#${WALL_ID}=IFCWALL('0Wall00000000000000042',$,'Wall A',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

const ZONE_SET: ZoneSet = {
  id: 'set-1',
  name: 'Takt areas',
  zones: [{ id: 'z-a', name: 'Takt A', center: [0, 0, 0], size: [10, 10, 10], rotationY: 0 }],
  visible: true,
  createdAt: 0,
  updatedAt: 0,
};

async function seed(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(MINI_IFC);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  useViewerStore.setState({
    models: new Map([['m1', { id: 'm1', name: 'zones.ifc', ifcDataStore: store, visible: true } as never]]),
    zoneSets: [ZONE_SET],
    zoneAssignments: new Map([[WALL_ID, {
      'set-1': { zoneId: 'z-a', zoneName: 'Takt A', straddles: false, touchedZoneIds: ['z-a'] },
    }]]) as never,
    zoneApportionment: new Map(),
    mutationViews: new Map(),
    dirtyModels: new Set(),
  } as never);
  return store;
}

function writeButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === 'Write to model');
  assert.ok(button, `no write button; buttons were: ${[...container.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  return button as HTMLButtonElement;
}

after(cleanup);

describe('ZonesPanel: writing zone data into the model', () => {
  beforeEach(async () => {
    await seed();
  });

  it('writes the property set when the panel button is clicked', () => {
    const container = render(<ZonesPanel />);

    // Nothing before the click: the panel must not write on mount.
    assert.equal(useViewerStore.getState().getMutationView('m1'), null);

    click(writeButton(container));

    const psets = useViewerStore.getState().getMutationView('m1')?.getForEntity(WALL_ID) ?? [];
    assert.ok(
      psets.some((p) => p.name === zonePropertySetName('Takt areas')),
      `zone pset not written; got ${psets.map((p) => p.name).join(', ')}`,
    );
    assert.ok(useViewerStore.getState().dirtyModels.has('m1'));
  });

  it('removes it again from the same panel', () => {
    const container = render(<ZonesPanel />);
    click(writeButton(container));

    const remove = [...container.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'Remove zone properties');
    assert.ok(remove, 'no remove control');
    click(remove);

    const psets = useViewerStore.getState().getMutationView('m1')?.getForEntity(WALL_ID) ?? [];
    assert.ok(!psets.some((p) => p.name === zonePropertySetName('Takt areas')));
  });
});
