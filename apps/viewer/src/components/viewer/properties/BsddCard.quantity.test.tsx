/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A bSDD Qto_* row used to author a NaN placeholder no surface could fill in,
 * and the exporter refuses NaN, so one click made every later IFC export (and
 * the material panel's background export) fail (#8407).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { TooltipProvider } from '@/components/ui/tooltip.js';
import { render, click, cleanup, type } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { BsddCard } from './BsddCard.js';

const RESPONSE = {
  uri: 'https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcWall',
  code: 'IfcWall',
  name: 'IfcWall',
  definition: 'A wall.',
  classProperties: [
    { name: 'Length', propertyCode: 'Length', propertyUri: 'length', description: null, dataType: 'Real', propertySet: 'Qto_WallBaseQuantities', units: ['m'] },
    { name: 'Height', propertyCode: 'Height', propertyUri: 'height', description: null, dataType: 'Real', propertySet: 'Qto_WallBaseQuantities', units: ['m'] },
  ],
};

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project00000000000001',$,'Project',$,$,$,$,$,$);
#10=IFCWALL('0Wall00000000000000010',$,'Wall A',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

const realFetch = globalThis.fetch;
const originalState = useViewerStore.getState();
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  useViewerStore.setState(originalState, true);
});

async function mountQuantityRows(view: MutablePropertyView): Promise<{ ui: HTMLElement; store: IfcDataStore }> {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer, { disableWorkerScan: true });
  globalThis.fetch = (async () => new Response(JSON.stringify(RESPONSE), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;
  const model = { ...fixtureModel('m1'), ifcDataStore: store, schemaVersion: 'IFC4' as const };
  useViewerStore.setState({ ...fixtureModels(model), editEnabled: true, mutationViews: new Map([['m1', view]]) });
  const ui = render(
    <TooltipProvider>
      <BsddCard entityType="IfcWall" modelId="m1" entityId={10} existingPsets={[]} existingProps={new Set<string>()} />
    </TooltipProvider>,
  );
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  const header = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Qto_WallBaseQuantities'));
  assert.ok(header, 'Qto_WallBaseQuantities group rendered');
  click(header);
  return { ui, store };
}

function added(view: MutablePropertyView) {
  return view.getQuantitiesForEntity(10).flatMap((set) => set.quantities).map((q) => [q.name, q.value]);
}

describe('BsddCard Qto_* rows (#8407)', () => {
  it('adds a quantity with the value the user typed, never a placeholder', async () => {
    const view = new MutablePropertyView(null, 'm1');
    const { ui, store } = await mountQuantityRows(view);
    const input = ui.querySelector<HTMLInputElement>('input[aria-label="Value for Length"]');
    assert.ok(input, 'the Length row asks for a value');
    const add = input.nextElementSibling as HTMLButtonElement;

    assert.equal(add.disabled, true, 'nothing can be added before a value exists');
    type(input, 'abc');
    assert.equal(add.disabled, true, 'a value that is not a number cannot be added');
    assert.deepEqual(added(view), []);

    type(input, '4.5');
    click(add);
    assert.deepEqual(added(view), [['Length', 4.5]]);

    const exported = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true, includeQuantities: true });
    assert.match(new TextDecoder().decode(exported.content), /IFCQUANTITYLENGTH\('Length',.*,4\.5/);
  });

  it('offers no bulk add for a quantity set, since each quantity needs its own value', async () => {
    const view = new MutablePropertyView(null, 'm1');
    const { ui } = await mountQuantityRows(view);
    const header = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Qto_WallBaseQuantities'));
    assert.equal(header?.querySelector('button'), null);
  });
});
