/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { render, cleanup, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { RawStepCard } from './RawStepCard.js';

afterEach(cleanup);

const STEP = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCLOCALPLACEMENT($,#2);
#2=IFCAXIS2PLACEMENT2D(#3);
#3=IFCCARTESIANPOINT((0.,0.));
#4=IFCCARTESIANPOINT((1.,1.));
#10=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

async function setup() {
  const bytes = new TextEncoder().encode(STEP);
  const dataStore = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(dataStore.properties ?? null, 'raw-step-model');
  view.setExpressIdWatermark(10);
  useViewerStore.setState({ mutationViews: new Map([['raw-step-model', view]]), mutationVersion: 0 });
  return { dataStore, view };
}

function follow(container: HTMLElement, id: number): void {
  const chip = [...container.querySelectorAll('button')].find((button) => button.textContent === `#${id}`);
  assert.ok(chip, `reference #${id} is shown as a navigation chip`);
  click(chip);
}

it('#5249 Raw STEP wrapper navigation follows a queued positional reference', async () => {
  const { dataStore, view } = await setup();
  view.setPositionalAttribute(2, 0, '#4');

  const ui = render(<RawStepCard modelId="raw-step-model" entityId={1}
    entityType="IfcLocalPlacement" dataStore={dataStore} enableEditing />);
  follow(ui, 2);
  assert.ok(ui.querySelector('span[title$=" #4"]'), 'navigation opens the edited target #4');
  assert.equal(ui.querySelector('span[title$=" #3"]'), null);
});

it('#5249 Raw STEP wrapper navigation follows an overlay-created wrapper', async () => {
  const { dataStore, view } = await setup();
  const wrapper = view.createEntity('IfcAxis2Placement2D', ['#4']);
  view.setPositionalAttribute(1, 1, `#${wrapper.expressId}`);

  const ui = render(<RawStepCard modelId="raw-step-model" entityId={1}
    entityType="IfcLocalPlacement" dataStore={dataStore} enableEditing />);
  follow(ui, wrapper.expressId);
  assert.ok(ui.querySelector('span[title$=" #4"]'), 'navigation passes through the created wrapper to #4');
});
