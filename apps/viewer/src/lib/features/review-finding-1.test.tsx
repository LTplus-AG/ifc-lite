/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from './index';
import { GeoreferencingPanel } from '@/components/viewer/properties/GeoreferencingPanel';

const initial = useViewerStore.getState();
const tourStorage = window.localStorage.getItem('ifc-lite:tours:v1');
afterEach(() => {
  cleanup();
  resetFeaturesForTest();
  useViewerStore.setState(initial, true);
  if (tourStorage === null) window.localStorage.removeItem('ifc-lite:tours:v1');
  else window.localStorage.setItem('ifc-lite:tours:v1', tourStorage);
});
it('does not mount the location map from GeoreferencingPanel when third parties are off (#10176)', () => {
  const panel = () => render(<GeoreferencingPanel schemaVersion="IFC4" georef={{ hasGeoreference: true, source: 'mapConversion',
    mapConversion: { id: 1, sourceCRS: 2, targetCRS: 3, eastings: 0, northings: 0, orthogonalHeight: 0, scale: 1 },
    projectedCRS: { id: 3, name: 'unknown' },
  }} />);
  assert.ok(panel().querySelector('.lucide-map'));
  cleanup();
  resetFeaturesForTest({ default: 'all', disable: ['privacy.third-party'] });
  assert.ok(!panel().querySelector('.lucide-map'));
});