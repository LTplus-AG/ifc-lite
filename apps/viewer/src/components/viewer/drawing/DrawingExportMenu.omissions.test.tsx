/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { loadDialogs } from '@/test/dialog-host.js';
import type { DrawingSheet } from '@ifc-lite/drawing-2d';
import { DrawingExportMenu, type DrawingExportMenuProps } from './DrawingExportMenu.js';

afterEach(() => cleanup());

const emptyCounts = { measurements: 0, areas: 0, texts: 0, clouds: 0 };

function props(overrides: Partial<DrawingExportMenuProps> = {}): DrawingExportMenuProps {
  return {
    hasDrawing: true, compact: false,
    onExportSvg: () => {}, onExportDxf: () => {}, onExportPdf: () => {}, onPrint: () => {},
    displayedScale: 100, sheetEnabled: false, activeSheet: null,
    markupCounts: emptyCounts, visibleUnderlayCount: 0,
    ...overrides,
  };
}

function openMenu(): void {
  const trigger = document.body.querySelector<HTMLElement>('button[aria-label="Export"]');
  assert.ok(trigger);
  act(() => { trigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })); });
  click(trigger);
}

function selectItem(label: string): void {
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((element) => element.textContent?.includes(label));
  assert.ok(item, `${label} is available from the drawing export menu`);
  click(item);
}

function sheet(): DrawingSheet {
  return {
    id: 'sheet', name: 'Test sheet',
    paper: { id: 'A3', name: 'A3', category: 'ISO', widthMm: 420, heightMm: 297, orientation: 'landscape', defaultMarginMm: 15 },
    frame: {} as DrawingSheet['frame'], titleBlock: {} as DrawingSheet['titleBlock'],
    scaleBar: {} as DrawingSheet['scaleBar'], northArrow: {} as DrawingSheet['northArrow'],
    scale: { name: '1:50', factor: 50, useCase: '' },
    viewportBounds: { x: 0, y: 0, width: 100, height: 100 }, revisions: [],
  };
}

describe('drawing export notices (#5850)', () => {
  it('lists omitted markups and underlays before vector PDF export without changing the scale argument', () => {
    const scales: Array<number | undefined> = [];
    render(<DrawingExportMenu {...props({
      markupCounts: { ...emptyCounts, texts: 1 }, visibleUnderlayCount: 1,
      onExportPdf: (scale) => scales.push(scale),
    })} />);
    openMenu();
    selectItem('Download PDF');
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /drawing markups/);
    assert.match(dialog.textContent ?? '', /visible DXF reference underlays/);
    const exportButton = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Export');
    assert.ok(exportButton);
    click(exportButton);
    assert.deepEqual(scales, [undefined]);
  });

  it('does not claim sheet PDF omits underlays it embeds; the sheet scale stays fixed', () => {
    render(<DrawingExportMenu {...props({ sheetEnabled: true, activeSheet: sheet(), visibleUnderlayCount: 1 })} />);
    openMenu();
    selectItem('Download PDF');
    const dialog = document.body.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.doesNotMatch(dialog.textContent ?? '', /will leave out/i);
    assert.match(dialog.textContent ?? '', /Fixed by the active sheet \(1:50\)/);
    assert.equal(dialog.querySelector('[role="combobox"]'), null, 'the sheet cannot offer an ignored scale control');
  });

  it('asks before DXF drops content, and cancellation leaves the exporter untouched', async () => {
    const { ConfirmDialogHost } = await loadDialogs();
    let exports = 0;
    render(<>
      <DrawingExportMenu {...props({
        markupCounts: { ...emptyCounts, measurements: 1 }, visibleUnderlayCount: 1,
        onExportDxf: () => { exports++; },
      })} />
      <ConfirmDialogHost />
    </>);
    openMenu();
    selectItem('Download DXF');
    const first = document.body.querySelector('[role="alertdialog"]');
    assert.ok(first, 'DXF notice is shown before download');
    assert.match(first.textContent ?? '', /drawing markups/);
    assert.match(first.textContent ?? '', /visible DXF reference underlays/);
    assert.equal(exports, 0);
    const cancel = [...first.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Cancel');
    assert.ok(cancel);
    click(cancel);
    assert.equal(exports, 0);

    openMenu();
    selectItem('Download DXF');
    const second = document.body.querySelector('[role="alertdialog"]');
    assert.ok(second);
    const confirm = [...second.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Export anyway');
    assert.ok(confirm);
    click(confirm);
    await waitFor(() => exports === 1, 'confirming exports exactly once');
  });

  it('exports immediately when the DXF writer has nothing to omit', () => {
    let exports = 0;
    render(<DrawingExportMenu {...props({ onExportDxf: () => { exports++; } })} />);
    openMenu();
    selectItem('Download DXF');
    assert.equal(exports, 1);
    assert.equal(document.body.querySelector('[role="alertdialog"]'), null);
  });
});
