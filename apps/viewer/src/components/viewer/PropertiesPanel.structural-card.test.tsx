/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4736: a structural member with no ordinary property sets must still reach
 * the Structural Analysis card instead of the Properties tab's empty state.
 * #9668: the card lists the physical-to-analytical counterparts from either
 * end and selects one on click.
 */

import '@/test/setup-dom.js';

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activate, cleanup, click, render, waitFor } from '@/test/render.js';
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

const LINKED_SOURCE = SOURCE.replace('#10=', `#20=IFCWALL('wall-gid',$,'Wall A',$,$,$,$,$,$);
#21=IFCWALL('wall-2-gid',$,'Wall B',$,$,$,$,$,$);
#11=IFCSTRUCTURALCURVECONNECTION('connection-gid',$,'Edge',$,$,$,$,$,$);
#12=IFCSTRUCTURALCURVEMEMBER('member-2-gid',$,'Rib',$,$,$,$,.RIGID_JOINED_MEMBER.,$);
#30=IFCRELASSIGNSTOPRODUCT('rel-gid',$,$,$,(#10,#11),$,#20);
#10=`);

async function loadModel(source: string, expressId: number) {
  const bytes = new TextEncoder().encode(source);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  useViewerStore.setState({
    models: new Map([[MODEL_ID, { ...fixtureModel(MODEL_ID, { idOffset: ID_OFFSET }), ifcDataStore: store, maxExpressId: 30 }]]),
    activeModelId: MODEL_ID,
    selectedEntity: { modelId: MODEL_ID, expressId },
    selectedEntityId: ID_OFFSET + expressId,
    selectedEntityIds: new Set([ID_OFFSET + expressId]),
  });
}

/** Render the panel and wait for the lazily loaded structural card. */
async function renderPanel(): Promise<HTMLElement> {
  const ui = render(<PropertiesPanel />);
  await waitFor(() => ui.textContent?.includes('Structural Analysis') ?? false, 'the lazy structural card never rendered');
  return ui;
}

/** The counterpart row for `#id`, found by what the user sees. */
function counterpartRow(ui: HTMLElement, id: number): HTMLButtonElement {
  const row = [...ui.querySelectorAll('button')].find((button) => button.textContent?.startsWith(`#${id}`));
  assert.ok(row, `row #${id} in: ${ui.textContent}`);
  return row;
}

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

    const ui = await renderPanel();
    const text = ui.textContent ?? '';
    assert.ok(text.includes('Structural Analysis'), `structural card in: ${text}`);
    assert.ok(!text.includes('No property sets'), `empty state must not hide the card: ${text}`);
    const value = ui.querySelector<HTMLButtonElement>('button[title="Beam"]');
    assert.ok(value, '#5823 inline attribute value must be a keyboard control');
    activate(value, 'Enter');
    assert.ok(ui.querySelector('input[value="Beam"]'), 'Enter opens editing for the selected IFC Name');
  });

  it('lists analytical items for a wall and jumps there and back (#9668)', async () => {
    await loadModel(LINKED_SOURCE, 20);
    const ui = await renderPanel();
    assert.ok(ui.textContent?.includes('Analytical items (2)'), `wall card in: ${ui.textContent}`);
    assert.ok(counterpartRow(ui, 11).textContent?.includes('Edge'));

    click(counterpartRow(ui, 10));
    assert.deepEqual(useViewerStore.getState().selectedEntity, { modelId: MODEL_ID, expressId: 10 });
    assert.deepEqual([...useViewerStore.getState().selectedEntityIds], [ID_OFFSET + 10]);
    assert.ok(ui.textContent?.includes('Physical elements (1)'), `member card in: ${ui.textContent}`);

    click(counterpartRow(ui, 20));
    assert.deepEqual(useViewerStore.getState().selectedEntity, { modelId: MODEL_ID, expressId: 20 });
    assert.deepEqual([...useViewerStore.getState().selectedEntityIds], [ID_OFFSET + 20]);
  });

  it('shows the physical element of a connection (#9668)', async () => {
    await loadModel(LINKED_SOURCE, 11);
    const ui = await renderPanel();
    assert.ok(ui.textContent?.includes('Physical elements (1)'), `connection card in: ${ui.textContent}`);
    assert.ok(counterpartRow(ui, 20).textContent?.includes('Wall A'));
  });

  it('shows no counterpart section without a link (#9668)', async () => {
    await loadModel(LINKED_SOURCE, 12);
    const member = (await renderPanel()).textContent ?? '';
    assert.ok(member.includes('Structural Analysis') && !member.includes('Physical elements'), member);
    cleanup();
    await loadModel(LINKED_SOURCE, 21);
    // The card module is loaded by now, so an absent card is the gate's answer, not a pending import.
    const wall = render(<PropertiesPanel />).textContent ?? '';
    assert.ok(!wall.includes('Structural Analysis') && !wall.includes('Analytical items'), wall);
  });
});
