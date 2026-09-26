/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render, type } from '@/test/render.js';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { WORKSPACE_PANELS } from '@/lib/panels/registry';
import { PropertiesPanel } from './PropertiesPanel.js';

const guid = (name: string) => (name + '0'.repeat(22)).slice(0, 22);
const step = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m','2026',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1= IFCPROJECT('${guid('PROJ')}',$,'Proj',$,$,$,$,(#20),#30);
#20= IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21= IFCAXIS2PLACEMENT3D(#22,$,$);
#22= IFCCARTESIANPOINT((0.,0.,0.));
#30= IFCUNITASSIGNMENT((#31));
#31= IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#40= IFCLOCALPLACEMENT($,#21);
#72= IFCWALL('${guid('WALA')}',$,'Wall A',$,$,#40,$,'tagA',$);
#73= IFCWALL('${guid('WALB')}',$,'Wall B',$,$,#40,$,'tagB',$);
#81= IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('REI60'),$);
#82= IFCPROPERTYSINGLEVALUE('AcousticRating',$,IFCLABEL('Rw50'),$);
#80= IFCPROPERTYSET('${guid('PSTA')}',$,'Custom_A',$,(#81,#82));
#83= IFCRELDEFINESBYPROPERTIES('${guid('RDA')}',$,$,$,(#72,#73),#80);
#85= IFCPROPERTYSINGLEVALUE('LoadBearing',$,IFCBOOLEAN(.T.),$);
#84= IFCPROPERTYSET('${guid('PSTB')}',$,'Custom_B',$,(#85));
#86= IFCRELDEFINESBYPROPERTIES('${guid('RDB')}',$,$,$,(#72,#73),#84);
#181= IFCQUANTITYLENGTH('Width',$,$,200.);
#180= IFCELEMENTQUANTITY('${guid('QTO')}',$,'Qto_WallBaseQuantities',$,$,(#181));
#182= IFCRELDEFINESBYPROPERTIES('${guid('RDQ')}',$,$,$,(#72,#73),#180);
#200= IFCMATERIAL('Concrete',$,$);
#201= IFCPROPERTYSINGLEVALUE('ThermalConductivity',$,IFCREAL(1.4),$);
#202= IFCMATERIALPROPERTIES('Pset_MaterialConcrete',$,(#201),#200);
#203= IFCRELASSOCIATESMATERIAL('${guid('MAT')}',$,$,$,(#72,#73),#200);
ENDSEC;
END-ISO-10303-21;
`;

let initialState: ReturnType<typeof useViewerStore.getState>;

async function seed(): Promise<void> {
  const bytes = new TextEncoder().encode(step);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  useViewerStore.setState({
    models: new Map([['m', {
      id: 'm', name: 'm', ifcDataStore: store, geometryResult: null,
      visible: true, idOffset: 1_000_000, maxExpressId: 100_000, loadedAt: 1,
    }]]) as never,
    activeModelId: 'm', selectedEntity: { modelId: 'm', expressId: 72 },
    selectedEntityId: 1_000_072, selectedEntityIds: new Set<number>(),
    selectedModelId: null, selectedEntities: [], propertiesActiveTab: 'properties',
  });
}

function namedButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(text));
  assert.ok(button, `${text} button is visible`);
  return button;
}

describe('Properties find and section disclosure (#5899)', () => {
  before(() => { initialState = useViewerStore.getState(); });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    useViewerStore.setState(initialState, true);
  });

  it('filters property names and values across sets, highlights hits, and explains no match', async () => {
    await seed();
    const panel = render(<PropertiesPanel />);
    const find = panel.querySelector<HTMLInputElement>('input[aria-label="Find properties"]');
    assert.ok(find);
    type(find, 'Width');
    assert.equal(namedButton(panel, 'Qto_WallBaseQuantities').getAttribute('aria-expanded'), 'true', 'a quantity hit opens its tab and section');
    type(find, 'fire');
    assert.match(panel.textContent ?? '', /FireRating/);
    assert.doesNotMatch(panel.textContent ?? '', /AcousticRating|LoadBearing/);
    assert.equal(panel.querySelectorAll('[data-prop-key]').length, 1);
    assert.equal(panel.querySelector('mark')?.textContent, 'Fire');

    type(find, 'REI60');
    assert.match(panel.textContent ?? '', /FireRating/);
    assert.doesNotMatch(panel.textContent ?? '', /AcousticRating|LoadBearing/);
    type(find, 'ThermalConductivity');
    assert.match(panel.textContent ?? '', /Pset_MaterialConcrete|ThermalConductivity/);
    assert.equal(panel.querySelector('mark')?.textContent, 'ThermalConductivity');
    assert.doesNotMatch(panel.textContent ?? '', /FireRating|AcousticRating|LoadBearing/);
    type(find, 'absent-value');
    assert.match(panel.querySelector('output')?.textContent ?? '', /No matching properties or attributes/);
    const clear = panel.querySelector<HTMLButtonElement>('button[aria-label="Clear property search"]');
    assert.ok(clear);
    click(clear);
    assert.equal(find.value, '');
    assert.match(panel.textContent ?? '', /FireRating/);
  });

  it('keeps Quantities collapsed across selection and remount; search temporarily opens matches', async () => {
    await seed();
    let panel = render(<PropertiesPanel />);
    act(() => useViewerStore.setState({ propertiesActiveTab: 'quantities' }));
    const quantities = namedButton(panel, 'Qto_WallBaseQuantities');
    click(quantities);
    assert.equal(quantities.getAttribute('aria-expanded'), 'false');

    act(() => useViewerStore.setState({ selectedEntity: { modelId: 'm', expressId: 73 }, selectedEntityId: 1_000_073 }));
    assert.equal(namedButton(panel, 'Qto_WallBaseQuantities').getAttribute('aria-expanded'), 'false');
    cleanup();
    panel = render(<PropertiesPanel />);
    assert.equal(namedButton(panel, 'Qto_WallBaseQuantities').getAttribute('aria-expanded'), 'false');

    const find = panel.querySelector<HTMLInputElement>('input[aria-label="Find properties"]');
    assert.ok(find);
    type(find, 'Width');
    assert.equal(namedButton(panel, 'Qto_WallBaseQuantities').getAttribute('aria-expanded'), 'true');
    assert.equal(panel.querySelector('mark')?.textContent, 'Width');
    type(find, '');
    assert.equal(namedButton(panel, 'Qto_WallBaseQuantities').getAttribute('aria-expanded'), 'false');
  });

  it('remembers a material section across element selections', async () => {
    await seed();
    const panel = render(<PropertiesPanel />);
    const material = namedButton(panel, 'Concrete');
    click(material);
    assert.equal(material.getAttribute('aria-expanded'), 'false');
    act(() => useViewerStore.setState({ selectedEntity: { modelId: 'm', expressId: 73 }, selectedEntityId: 1_000_073 }));
    assert.equal(namedButton(panel, 'Concrete').getAttribute('aria-expanded'), 'false');
  });

  it('uses Properties as the panel name in the viewer and registry', () => {
    useViewerStore.setState({ ifcDataStore: null, geometryResult: null, models: new Map(), selectedEntity: null, selectedEntityId: null, selectedModelId: null, selectedEntities: [] });
    const panel = render(<PropertiesPanel />);
    assert.equal(panel.querySelector('h2')?.textContent, 'Properties');
    assert.equal(WORKSPACE_PANELS.find((panel) => panel.id === 'properties')?.title, 'Properties');
  });
});
