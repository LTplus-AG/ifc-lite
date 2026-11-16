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
import type { MapConversion } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { render, cleanup, waitFor } from '@/test/render';
import { spatialReferenceFromIfc } from '@/lib/geo/ifc-spatial-reference';
import { useSiteContextAnchor } from './SiteContextSection';

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
  return <span data-testid="anchor">{anchor?.ok ? `${modelId}@${Math.round(anchor.centre.x)}` : 'none'}</span>;
}

afterEach(() => { cleanup(); useViewerStore.setState({ models: new Map(), activeModelId: null }); });

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
