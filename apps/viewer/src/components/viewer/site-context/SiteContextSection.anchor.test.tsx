/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10481 review: the Site context section never offers a load with an anchor
 * that belongs to other inputs. When the selected model or its georeference
 * changes, the previous result is withheld (Load unavailable) until the new
 * one resolves, so a click in between cannot send the old centre with the new
 * model.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { IfcParser, type MapConversion } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { render, cleanup, waitFor, click, settle } from '@/test/render';
import { spatialReferenceFromIfc } from '@/lib/geo/ifc-spatial-reference';
import { SiteContextSection, useSiteContextAnchor } from './SiteContextSection';

const FRAME: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 10, z: 5 } },
  shiftedBounds: { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 10, z: 5 } },
  hasLargeCoordinates: false,
};

function swissModel(id: string, eastings: number): FederatedModel {
  const mapConversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3, eastings, northings: 1_200_000, orthogonalHeight: 500 };
  const spatialReference = spatialReferenceFromIfc({ mapConversion, projectedCRS: { id: 3, name: 'EPSG:2056', mapUnitScale: 1, verticalDatum: 'LN02' }, lengthUnitScale: 1, coordinateInfo: FRAME });
  return { ...fixtureModel(id), ifcDataStore: undefined, loadedAt: 1, spatialReference, geometryResult: { meshes: [], coordinateInfo: FRAME } } as unknown as FederatedModel;
}

function Probe() {
  const modelId = useViewerStore((s) => s.activeModelId) ?? '';
  const anchor = useSiteContextAnchor(modelId);
  return <span data-testid="anchor">{anchor?.ok ? `${modelId}@${Math.round(anchor.centre.x)}` : anchor?.reason ?? 'none'}</span>;
}

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

test('switching the selected model withholds the previous anchor until the new one resolves', async () => {
  const a = swissModel('A', 2_600_000);
  const b = swissModel('B', 2_610_000);
  useViewerStore.setState({ models: new Map([['A', a], ['B', b]]), activeModelId: 'A', anchorModelIdOverride: null });
  const host = render(<Probe />);
  const text = () => host.querySelector('[data-testid="anchor"]')!.textContent;
  await waitFor(() => text() === 'A@2600000', 'model A\'s anchor');
  // The first render after the switch (flushed synchronously, before any resolution can finish).
  act(() => { useViewerStore.setState({ activeModelId: 'B' }); });
  assert.notEqual(text(), 'B@2600000', 'never B paired with A\'s centre');
  assert.equal(text(), 'none');
  await waitFor(() => text() === 'B@2610000', 'model B\'s anchor');
});


for (const change of ['override', 'order', 'removal'] as const) {
  test(`the mounted section withdraws its old result when federation ${change} changes (#10481)`, async () => {
    const good = swissModel('good', 2600000); good.loadedAt = 0;
    const bad = swissModel('bad', 2600000); bad.loadedAt = 0;
    bad.spatialReference = spatialReferenceFromIfc({ mapConversion: { id: 1, sourceCRS: 2, targetCRS: 3, eastings: 2600000, northings: 1200000, orthogonalHeight: 500 },
      projectedCRS: { id: 3, name: 'EPSG:2056', mapUnitScale: 1, verticalDatum: 'LHN95' }, lengthUnitScale: 1, coordinateInfo: FRAME });
    const selected = swissModel('selected', 2600000); selected.loadedAt = 2;
    useViewerStore.setState({ models: new Map([['good', good], ['bad', bad], ['selected', selected]]), activeModelId: selected.id, anchorModelIdOverride: null });
    const host = render(<><Probe /><SiteContextSection modelId="selected" /></>);
    const text = () => host.querySelector('[data-testid="anchor"]')!.textContent;
    await waitFor(() => text() === 'selected@2600000', 'initial allowed anchor');
    act(() => {
      if (change === 'override') useViewerStore.setState({ anchorModelIdOverride: 'bad' });
      else useViewerStore.setState({ models: new Map(change === 'order' ? [['bad', bad], ['good', good], ['selected', selected]] : [['bad', bad], ['selected', selected]]) });
    });
    assert.equal(useViewerStore.getState().models.get('selected'), selected);
    assert.equal(text(), 'none', 'the old successful result is withheld synchronously');
    await waitFor(() => host.textContent?.includes('EPSG:5729') === true, 'visible federation height refusal');
    assert.equal(text(), 'height-datum');
    assert.equal([...host.querySelectorAll('button')].some(b => b.textContent?.includes('Load site context')), false);
  });
}

test('editing only the IFC reference mutations changes the mounted height refusal (#10481)', async () => {
  const bytes = new TextEncoder().encode(`ISO-10303-21;
HEADER;FILE_DESCRIPTION(('Reference'),'2;1');FILE_NAME('reference.ifc','',(),(),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);
#4=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#5=IFCPROJECTEDCRS('EPSG:2056',$,$,'LN02',$,$,#4);
#6=IFCMAPCONVERSION(#3,#5,2600000.,1200000.,500.,1.,0.,1.);
#7=IFCUNITASSIGNMENT((#4));
#8=IFCPROJECT('0000000000000000000001',$,'Reference',$,$,$,$,(#3),#7);
ENDSEC;END-ISO-10303-21;`);
  const selected = swissModel('selected', 2600000); selected.loadedAt = 2;
  const reference = { ...fixtureModel('reference'), loadedAt: 0, ifcDataStore: await new IfcParser().parseColumnar(bytes.buffer), geometryResult: selected.geometryResult };
  useViewerStore.setState({ models: new Map([['reference', reference], ['selected', selected]]), activeModelId: 'selected', anchorModelIdOverride: 'reference', georefMutations: new Map() });
  const host = render(<><Probe /><SiteContextSection modelId="selected" /></>);
  const text = () => host.querySelector('[data-testid="anchor"]')!.textContent;
  await waitFor(() => text() === 'selected@2600000', 'IFC reference initial datum');
  const models = useViewerStore.getState().models;
  act(() => useViewerStore.setState({ georefMutations: new Map([['reference', { projectedCRS: { verticalDatum: 'LHN95' } }]]) }));
  assert.equal(useViewerStore.getState().models, models, 'no model identity changed');
  assert.equal(text(), 'none');
  await waitFor(() => host.textContent?.includes('EPSG:5729') === true, 'mutated reference datum refusal');
});

for (const failure of ['import', 'load'] as const) {
  test(`a rejected ${failure} produces a visible error in the mounted section (#10481)`, async () => {
    const selected = swissModel('selected', 2600000);
    useViewerStore.setState({ models: new Map([['selected', selected]]), activeModelId: selected.id, anchorModelIdOverride: null });
    const message = failure === 'import' ? 'The context module is unavailable' : 'The context load failed';
    const loadContext = async () => {
      if (failure === 'import') throw new Error(message);
      return { loadSiteContext: async () => { throw new Error(message); } };
    };
    const host = render(<SiteContextSection modelId="selected" loadContext={loadContext} />);
    const button = () => [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Load site context'));
    await waitFor(() => !!button(), 'load button');
    click(button()!);
    await waitFor(() => host.querySelector('[role="alert"]')?.textContent === message, 'visible rejected load feedback');
    assert.equal(button()?.disabled, false);
    assert.equal(useViewerStore.getState().siteContextAbort, null);
  });
}


test('removing the context anchor hides its note while context models stay loaded (#10481 r4588747577)', async () => {
  const a = swissModel('anchor-uuid', 2_600_000);
  const b = swissModel('B', 2_610_000);
  const context = fixtureModel('ctx-terrain');
  const categories = { terrain: { status: 'done' as const, modelId: context.id, anchorModelId: a.id, issues: [], attribution: [] } };
  useViewerStore.setState({ models: new Map([[a.id, a], [b.id, b], [context.id, context]]), activeModelId: b.id,
    anchorModelIdOverride: null, siteContextCategories: categories });
  const host = render(<SiteContextSection modelId={b.id} />);
  const note = () => host.querySelector('[data-testid="site-context-other-anchor"]');
  await waitFor(() => !!note(), 'note for the loaded anchor');
  assert.ok(note()!.textContent?.includes(a.name));
  act(() => { useViewerStore.getState().removeModel(a.id); });
  await settle();
  await waitFor(() => host.textContent?.includes('Load site context') === true, 'model B site context section', 5_000);
  // Compare a primitive so a regression
  // cannot make node:assert inspect the DOM's cyclic object graph (#10545).
  assert.equal(note() === null, true, 'no raw UUID for a removed anchor');
  assert.equal(useViewerStore.getState().models.get(context.id), context, 'context model remains in the scene');
  assert.equal(useViewerStore.getState().siteContextCategories.terrain?.status, 'done');
});
