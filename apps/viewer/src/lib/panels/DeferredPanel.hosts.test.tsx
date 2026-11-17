/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { cleanup, click, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { formFactorState } from '@/test/form-factor-state';
import { BottomStrip } from '@/components/viewer/BottomStrip';
import { MobilePanelSheet } from '@/components/viewer/MobilePanelSheet';
import { bottomPanelFlags } from './bottom-panels';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

for (const [id, mobile] of [['gantt', false], ['lists', true]] as const) {
  it(`#9742 ${mobile ? 'mobile sheet' : 'docked strip'} owns the only close row while ${id} loads`, async () => {
    const bytes = readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
    const ifcDataStore = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer);
    useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore }), ...bottomPanelFlags(id), loading: false, ...formFactorState(mobile), rightPanelCollapsed: false });
    let closed = 0;
    render(mobile ? <MobilePanelSheet analysisExtension={null} />
      : <BottomStrip dockedPanel={id} analysisExtension={null} containerRef={{ current: null }} closePanel={() => { closed++; }} />);
    assert.ok(document.querySelector('output[aria-live="polite"]'), 'real cold router still announces loading');
    const close = [...document.querySelectorAll('button')].filter(button => button.getAttribute('aria-label') === 'Close');
    assert.equal(close.length, 1, 'host header remains the only title/close row from its initial mount');
    click(close[0]);
    if (mobile) assert.equal(useViewerStore.getState().rightPanelCollapsed, true);
    else assert.equal(closed, 1);
  });
}
