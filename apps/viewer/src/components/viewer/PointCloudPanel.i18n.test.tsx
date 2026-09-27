/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PointCloudPanel`'s own chrome reads the i18n catalogue (#4918 sweep,
 * `misc-panels-b.en.ts`). Same shape as `MergeLayersBanner.i18n.test.tsx`:
 * render with the default (English) locale, then register a partial
 * locale overriding one key from each of the panel's own sections —
 * static label, `labelKey`/`hintKey` data-table row (`COLOR_MODES`), and
 * an interpolated plural — and assert the swap lands while an unrelated
 * key still falls back to English.
 */
import '@/test/setup-dom.js';
import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click } from '@/test/render';
import { registerLocale, setLocale } from '@/i18n';
import { PointCloudPanel } from './PointCloudPanel';

afterEach(() => {
  cleanup();
  setLocale('en');
});

it('renders the English catalogue value by default (#4918)', () => {
  const container = render(<PointCloudPanel assetCount={2} triangleCount={0} />);
  assert.ok(container.textContent?.includes('Point Cloud'));
  assert.ok(container.textContent?.includes('2 assets'));
  assert.ok(container.textContent?.includes('Colour'));
  assert.ok(container.textContent?.includes('RGB'));
  assert.ok(container.textContent?.includes('Classification'));
  assert.ok(container.textContent?.includes('Size'));
  assert.ok(container.textContent?.includes('Edge shading'));
});

it('pluralizes the asset-count readout (#4918)', () => {
  const single = render(<PointCloudPanel assetCount={1} triangleCount={0} />);
  assert.ok(single.textContent?.includes('1 asset'));
  assert.ok(!single.textContent?.includes('1 assets'));
});

it('#5811 names and activates the point cloud panel close control', () => {
  let closed = 0;
  const container = render(<PointCloudPanel assetCount={1} triangleCount={0} onClose={() => { closed += 1; }} />);
  const close = container.querySelector('button[aria-label="Close point cloud panel"]');
  assert.ok(close);
  click(close);
  assert.equal(closed, 1);
});

it('translates the title and a data-table label, while an untranslated key falls back to English (#4918)', () => {
  registerLocale('pointcloudpanel-de', {
    'pointCloudPanel.title': 'Punktwolke',
    'pointCloudPanel.colorMode.rgb.label': 'RGB (de)',
  });
  act(() => setLocale('pointcloudpanel-de'));
  const container = render(<PointCloudPanel assetCount={3} triangleCount={0} />);
  assert.ok(container.textContent?.includes('Punktwolke'));
  assert.ok(container.textContent?.includes('RGB (de)'));
  // `colourSectionLabel` is not in the partial locale: must still fall back.
  assert.ok(container.textContent?.includes('Colour'));
});
