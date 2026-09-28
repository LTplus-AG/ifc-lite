/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { act } from 'react';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, click } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { en } from '@/i18n/en';
import { useViewerStore } from '@/store';
import type { SweptDiskDescriptions } from '@ifc-lite/geometry';
import { formatAnalyticLength, SweptDiskInspection, SweptDiskRecord } from './SweptDiskInspection.js';

type Occurrence = SweptDiskDescriptions['elements'][string][number];
const COMPLETE: Occurrence = {
  solid_id: 12,
  directrix_id: 13,
  mapping_path: [14, 15],
  source_modified: false,
  Radius: 0.008,
  InnerRadius: 0.004,
  status: { type: 'complete' },
  Directrix: [
    { type: 'line', start: [0, 0, 0], end: [2, 0, 0] },
    { type: 'arc', center: [2, 1, 0], normal: [0, 0, 1], x_axis: [1, 0, 0],
      radius: 1, start_angle: 0, sweep_angle: -Math.PI / 2 },
  ],
  directrix_metrics: {
    total_length: 2 + Math.PI / 2,
    segments: [
      { segment_index: 0, length: 2, bend_angle: null },
      { segment_index: 1, length: Math.PI / 2, bend_angle: Math.PI / 2 },
    ],
  },
};

const prior = useViewerStore.getState();
afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(prior, true);
});

describe('swept-disk source inspection (#5783)', () => {
  it('shows per-segment analytic lengths and selects the arc without altering mesh measurements', () => {
    useViewerStore.setState({ unitDisplayOverrides: { LENGTHUNIT: 'ft' }, selectedDirectrixSegment: null,
      centrelineOverlayEnabled: false, measurements: [] });
    const ui = render(<SweptDiskRecord occurrence={COMPLETE} occurrenceIndex={1} modelId="rebar-model" expressId={42} />);
    const text = ui.textContent ?? '';
    assert.match(text, /IfcSweptDiskSolid #12/);
    assert.match(text, /#14 → #15/);
    assert.match(text, /InnerRadius:/);
    assert.match(text, /Total centreline length/);
    assert.match(text, /Bend magnitude/);
    assert.match(text, /Signed sweep: -/);
    assert.match(text, /ft/);
    const segment = [...ui.querySelectorAll('button')].find((button) => button.textContent?.includes('Segment 2'));
    assert.ok(segment);
    click(segment);
    assert.deepEqual(useViewerStore.getState().selectedDirectrixSegment,
      { modelId: 'rebar-model', expressId: 42, occurrenceIndex: 1, segmentIndex: 1 });
    assert.equal(useViewerStore.getState().centrelineOverlayEnabled, true);
    assert.deepEqual(useViewerStore.getState().measurements, []);
    click(segment);
    assert.equal(useViewerStore.getState().selectedDirectrixSegment, null);
  });

  it('keeps two authored sweeps distinct even when their product ID is shared', () => {
    const ui = render(<>
      <SweptDiskRecord occurrence={COMPLETE} occurrenceIndex={0} modelId="first" expressId={42} />
      <SweptDiskRecord occurrence={{ ...COMPLETE, solid_id: 27, directrix_id: 28 }}
        occurrenceIndex={1} modelId="first" expressId={42} />
    </>);
    assert.equal(ui.querySelectorAll('section[aria-label^="IfcSweptDiskSolid"]').length, 2);
    assert.match(ui.textContent ?? '', /IfcSweptDiskSolid #12/);
    assert.match(ui.textContent ?? '', /IfcSweptDiskSolid #27/);
  });

  it('marks unsupported and source-modified records without presenting a derived length', () => {
    const unsupported: Occurrence = { ...COMPLETE, status: { type: 'unsupported', reason: 'unsupported directrix curve' },
      source_modified: true, directrix_metrics: null };
    const ui = render(<SweptDiskRecord occurrence={unsupported} occurrenceIndex={0} modelId="m" expressId={7} />);
    const text = ui.textContent ?? '';
    assert.match(text, /Unsupported/);
    assert.match(text, /unsupported directrix curve/);
    assert.match(text, /Source directrix may differ/);
    assert.match(text, /authored value/);
    assert.ok(!text.includes('Total centreline length'));
  });

  it('keeps measurements visible but blocks mesh highlighting for a CSG-modified source', () => {
    const ui = render(<SweptDiskRecord occurrence={{ ...COMPLETE, source_modified: true }}
      occurrenceIndex={0} modelId="m" expressId={7} />);
    assert.match(ui.textContent ?? '', /Total centreline length/);
    assert.equal(ui.querySelectorAll('button[disabled]').length, 2);
  });

  it('formats analytic metres with display overrides without rounding to mesh readout precision', () => {
    assert.match(formatAnalyticLength(Math.PI, {}), /^3\.1415926536 m$/);
    assert.match(formatAnalyticLength(1, { LENGTHUNIT: 'mm' }), /^1,?000 mm$/);
  });

  it('renders swept-disk panel and record labels from the active pseudo-locale (#5783)', () => {
    const unsupported: Occurrence = { ...COMPLETE, InnerRadius: null, mapping_path: [],
      source_modified: true, status: { type: 'unsupported', reason: 'source curve unsupported' },
      directrix_metrics: null };
    const ui = render(<>
      <SweptDiskInspection enabled />
      <SweptDiskRecord occurrence={COMPLETE} occurrenceIndex={0} modelId="m" expressId={42} />
      <SweptDiskRecord occurrence={unsupported} occurrenceIndex={1} modelId="m" expressId={42} />
      <SweptDiskRecord occurrence={{ ...COMPLETE, source_modified: true }}
        occurrenceIndex={2} modelId="m" expressId={42} />
    </>);
    assert.match(ui.textContent ?? '', /Derived source geometry/);
    assert.match(ui.textContent ?? '', /Total centreline length/);

    const pseudo: Catalogue = Object.fromEntries(Object.entries(en)
      .filter(([key]) => key.startsWith('properties.sweptDisk.'))
      .map(([key, value]) => [key, typeof value === 'string' ? `⟦${key}|${value}⟧` : value]));
    registerLocale('swept-disk-pseudo', pseudo);
    act(() => setLocale('swept-disk-pseudo'));

    for (const suffix of [
      'heading', 'sourceNote', 'solid', 'status', 'complete', 'unsupported',
      'sourceModified', 'yes', 'no', 'directrix', 'mappingPath', 'none',
      'radius', 'innerRadius', 'unsupportedRadiusHint', 'derivedCentreline',
      'totalLength', 'segment', 'bend', 'signedSweep', 'modifiedHint',
    ]) {
      const key = `properties.sweptDisk.${suffix}`;
      assert.ok(ui.textContent?.includes(`⟦${key}|`), `${key} must render from the active locale`);
    }
    assert.ok([...ui.querySelectorAll('button[disabled]')].some((button) =>
      button.getAttribute('title')?.includes('⟦properties.sweptDisk.modifiedHighlightHint|')),
    'the modified-source tooltip must render from the active locale');
  });
});
