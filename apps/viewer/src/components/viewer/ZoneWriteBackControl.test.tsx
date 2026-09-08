/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The write-back control, driven from the panel that hosts it (#2508 item 3).
 *
 * `useZoneWriteBack.test.ts` and `useZoneSpatialZones.test.ts` prove the writes
 * themselves. What this proves is the half those files cannot: the buttons
 * exist ON the Zones panel, and CLICKING them writes. A test that asserts the control renders would pass just as well with
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
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,(#5),$);
#7=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#8,$);
#20=IFCLOCALPLACEMENT($,#8);
#30=IFCBUILDINGSTOREY('0storey000000000000000',$,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
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

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')]
    .find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
  assert.ok(found, `no "${label}" control; buttons were: ${[...container.querySelectorAll('button')].map((b) => b.textContent?.trim() || b.getAttribute('aria-label')).join(' | ')}`);
  return found as HTMLButtonElement;
}

function emittedZones(): string[] {
  return (useViewerStore.getState().getMutationView('m1')?.getNewEntities() ?? [])
    .filter((e) => e.type === 'IfcSpatialZone')
    .map((e) => String(e.attributes[2]));
}

describe('ZonesPanel: exporting the table', () => {
  beforeEach(async () => {
    await seed();
  });

  it('downloads a CSV when the panel button is clicked', async () => {
    // A presence check would pass with `onClick={() => {}}`, which is the
    // failure #2434 catalogued, so the assertion is the file: its bytes, its
    // name, and a row for the element that is actually in a zone.
    const downloads: Array<{ name: string; text: string }> = [];
    const originalCreate = URL.createObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    let pending: Blob | null = null;
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = (blob: Blob) => {
      pending = blob;
      return 'blob:zone-table';
    };
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      if (this.download && pending) downloads.push({ name: this.download, text: '' });
    };

    try {
      const container = render(<ZonesPanel />);
      click(button(container, 'CSV'));
      // The export is async (Parquet loads a wasm writer, so both formats go
      // through a promise); let it settle before asserting on the download.
      await new Promise((resolve) => setTimeout(resolve, 0));

      assert.equal(downloads.length, 1, 'the CSV button downloaded nothing');
      assert.equal(downloads[0].name, 'Takt areas-zone-quantities.csv');
      const text = await (pending as Blob | null)?.text();
      assert.ok(text?.startsWith('GlobalId,ExpressId,Model'), `unexpected header: ${text?.slice(0, 60)}`);
      assert.match(text ?? '', /0Wall00000000000000042/);
    } finally {
      (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreate;
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });
});

describe('ZonesPanel: emitting the zones themselves', () => {
  beforeEach(async () => {
    await seed();
  });

  it('emits an IfcSpatialZone when the panel button is clicked', () => {
    const container = render(<ZonesPanel />);
    assert.deepEqual(emittedZones(), [], 'the panel emitted on mount');

    click(button(container, 'Emit zones as IfcSpatialZone'));

    assert.deepEqual(emittedZones(), ['Takt A']);
    assert.ok(useViewerStore.getState().dirtyModels.has('m1'));
  });

  it('refuses a second click in the same tick as the first', async () => {
    // The guard has to be a REF: state has not re-rendered in the tick the
    // first click starts, so a state-only check lets a double click start two
    // full gathers and download the same table twice.
    const downloads: string[] = [];
    const originalCreate = URL.createObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:zone-table';
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      if (this.download) downloads.push(this.download);
    };
    try {
      const container = render(<ZonesPanel />);
      const csv = button(container, 'CSV');
      // Dispatched RAW rather than through the test helper's `click`: that one
      // wraps each event in `act`, which flushes the state update in between,
      // so a state-only guard would pass a check it cannot pass in the tick
      // the events actually share.
      csv.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      csv.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(downloads.length, 1, `two clicks produced ${downloads.length} downloads`);
    } finally {
      (URL as { createObjectURL: (b: Blob) => string }).createObjectURL = originalCreate;
      HTMLAnchorElement.prototype.click = originalClick;
    }
  });
});

describe('ZonesPanel: emitting the zones themselves (removal)', () => {
  beforeEach(async () => {
    await seed();
  });

  it('takes them out again from the same panel', () => {
    const container = render(<ZonesPanel />);
    click(button(container, 'Emit zones as IfcSpatialZone'));
    click(button(container, 'Remove emitted spatial zones'));
    assert.deepEqual(emittedZones(), []);
  });
});
