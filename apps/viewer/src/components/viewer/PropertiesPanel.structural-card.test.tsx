/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4736: a structural member with no ordinary property sets must still reach
 * the Structural Analysis card instead of the Properties tab's empty state.
 */

import '@/test/setup-dom.js';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activate, cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { IfcParser } from '@ifc-lite/parser';
import { PropertiesPanel } from './PropertiesPanel.js';

const MODEL_ID = 'structural-model';
const ID_OFFSET = 1_000_000;
const SOURCE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('structural.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Project',$,$,$,$,$,$);
#10=IFCSTRUCTURALCURVEMEMBER('member-gid',$,'Beam',$,$,$,$,.RIGID_JOINED_MEMBER.,$);
ENDSEC;
END-ISO-10303-21;
`;

let initialState: ReturnType<typeof useViewerStore.getState>;

describe('PropertiesPanel structural-only selection', () => {
  before(() => {
    initialState = useViewerStore.getState();
  });

  afterEach(() => {
    cleanup();
    useViewerStore.setState(initialState, true);
  });

  after(() => {
    useViewerStore.setState(initialState, true);
  });

  it('renders the structural card instead of No property sets', async () => {
    const bytes = new TextEncoder().encode(SOURCE);
    const store = await new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    const model = {
      ...fixtureModel(MODEL_ID, { idOffset: ID_OFFSET }),
      ifcDataStore: store,
      maxExpressId: 10,
    };
    useViewerStore.setState({
      models: new Map([[MODEL_ID, model]]),
      activeModelId: MODEL_ID,
      selectedEntity: { modelId: MODEL_ID, expressId: 10 },
      selectedEntityId: ID_OFFSET + 10,
      selectedEntityIds: new Set([ID_OFFSET + 10]),
      editEnabled: true,
    });

    const ui = render(<PropertiesPanel />);
    const text = ui.textContent ?? '';
    assert.ok(text.includes('Structural Analysis'), `structural card in: ${text}`);
    assert.ok(!text.includes('No property sets'), `empty state must not hide the card: ${text}`);
    const value = ui.querySelector<HTMLButtonElement>('button[title="Beam"]');
    assert.ok(value, '#5823 inline attribute value must be a keyboard control');
    activate(value, 'Enter');
    assert.ok(ui.querySelector('input[value="Beam"]'), 'Enter opens editing for the selected IFC Name');
  });
});
