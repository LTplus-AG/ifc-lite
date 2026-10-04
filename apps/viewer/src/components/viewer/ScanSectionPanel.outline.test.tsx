/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scan section panel's "Vector outline" mode (#6871), mounted: the
 * toggle switches the drawing option the scan layer reads, the bridge slider
 * appears only with it and drives the closing distance, and the status line
 * reports what a REAL trace (wasm engine on a seeded room slab) produced.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render, type } from '@/test/render.js';
import { ensureWasm, roomSlab } from '@/test/scan-slab-fixture';
import { useViewerStore } from '@/store';
import { traceScanOutlineLayer } from '@/lib/scan-outline/scan-outline';
import { ScanSectionPanel } from './ScanSectionPanel.js';

const options = () => useViewerStore.getState().drawing2DDisplayOptions;

function outlineToggle(container: HTMLElement): HTMLInputElement {
  const label = [...container.querySelectorAll('label')].find((l) => l.textContent?.includes('Vector outline'));
  assert.ok(label, 'the Vector outline toggle is rendered');
  return label.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

describe('ScanSectionPanel vector outline (#6871)', () => {
  beforeEach(() => {
    useViewerStore.getState().updateDrawing2DDisplayOptions({ scanSectionOutline: false, scanSectionOutlineMaxGap: 0.3 });
  });
  afterEach(() => cleanup());

  it('the toggle turns the outline on, and only then offers the bridge distance', () => {
    const container = render(<ScanSectionPanel hasPointCloud totalInBand={100} renderedCount={100} />);
    assert.equal(container.querySelector('#scan-section-outline-gap'), null, 'no slider while off');
    click(outlineToggle(container));
    assert.equal(options().scanSectionOutline, true);
    const slider = container.querySelector('#scan-section-outline-gap') as HTMLInputElement;
    assert.ok(slider, 'slider shown once on');
    assert.match(container.textContent ?? '', /Bridge gaps up to: 300 mm/);
    type(slider, '0.45');
    assert.equal(options().scanSectionOutlineMaxGap, 0.45);
    assert.match(container.textContent ?? '', /Bridge gaps up to: 450 mm/);
    click(outlineToggle(container));
    assert.equal(options().scanSectionOutline, false);
    assert.equal(container.querySelector('#scan-section-outline-gap'), null);
  });

  it('says it is tracing until the rings arrive, then reports the real trace', (t) => {
    if (!ensureWasm(t)) return;
    useViewerStore.getState().updateDrawing2DDisplayOptions({ showScanSection: true, scanSectionOutline: true });
    const pending = render(<ScanSectionPanel hasPointCloud totalInBand={100} renderedCount={100} outline={null} />);
    assert.match(pending.querySelector('output')?.textContent ?? '', /Tracing the outline/);
    cleanup();

    const outline = traceScanOutlineLayer(roomSlab(), 0.3);
    const container = render(<ScanSectionPanel hasPointCloud totalInBand={100} renderedCount={100} outline={outline} />);
    const status = container.querySelector('output')?.textContent ?? '';
    assert.match(status, new RegExp(`^${outline.rings.length} outline rings, traced on ${Math.round(outline.diagnostics.cellSize * 1000)} mm cells\\.$`));
    assert.equal(outline.rings.length, 2);
    assert.doesNotMatch(status, /cell budget/, 'no cap warning for a small slab');
  });

  it('warns when the cell budget forced coarser cells', (t) => {
    if (!ensureWasm(t)) return;
    useViewerStore.getState().updateDrawing2DDisplayOptions({ showScanSection: true, scanSectionOutline: true });
    const outline = traceScanOutlineLayer(roomSlab(), 0.3);
    const capped = { ...outline, diagnostics: { ...outline.diagnostics, cellCapHit: true } };
    const container = render(<ScanSectionPanel hasPointCloud totalInBand={100} renderedCount={100} outline={capped} />);
    assert.match(container.querySelector('output')?.textContent ?? '', /too large for the cell budget/);
  });
});
