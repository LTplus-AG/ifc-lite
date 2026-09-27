/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The PDF scale dialog (#5496) replaces `window.prompt`, but the thing that
 * actually matters is unchanged: the scale the user picks must reach
 * `handleExportPDF` unmodified, because that function is what proves the
 * exported PDF is byte-identical to before (see
 * `useDrawingExport.pdfVectorPaths.test.tsx`). Every assertion here reads the
 * argument the dialog's `onExport` seam was actually called with, following
 * `PdfViewExportDialog.test.tsx`'s "what the dialog SENDS" pattern rather than
 * a presence check.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click, type as typeInto } from '@/test/render';
import { DrawingPdfExportDialog } from './DrawingPdfExportDialog';
import type { DrawingSheet } from '@ifc-lite/drawing-2d';

afterEach(() => cleanup());

/** Radix Select opens on ArrowDown and portals its listbox to `document.body`. */
function chooseScale(optionLabel: string): void {
  const trigger = document.body.querySelector('#pdf-export-scale, [role="combobox"]');
  assert.ok(trigger, 'the scale select must render');
  act(() => {
    trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  });
  const option = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith(optionLabel));
  assert.ok(option, `the "${optionLabel}" option must be offered, got ${JSON.stringify([...document.body.querySelectorAll('[role="option"]')].map((o) => o.textContent))}`);
  act(() => {
    option.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

function exportButton(): HTMLButtonElement {
  const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Export');
  assert.ok(button, 'the Export button must render');
  return button as HTMLButtonElement;
}

function sheetFixture(): DrawingSheet {
  return {
    id: 's1', name: 'Sheet 1',
    paper: { id: 'A3_LANDSCAPE', name: 'A3 Landscape', category: 'ISO', widthMm: 420, heightMm: 297, orientation: 'landscape', defaultMarginMm: 15 },
    frame: {} as DrawingSheet['frame'],
    titleBlock: {} as DrawingSheet['titleBlock'],
    scaleBar: {} as DrawingSheet['scaleBar'],
    scale: { name: '1:50', factor: 50, useCase: '' },
    northArrow: {} as DrawingSheet['northArrow'],
    viewportBounds: { x: 0, y: 0, width: 100, height: 100 },
    revisions: [],
  };
}

describe('DrawingPdfExportDialog (#5496)', () => {
  it('"As displayed" sends undefined, matching the old prompt\'s blank-input behaviour', () => {
    const calls: Array<number | undefined> = [];
    render(
      <DrawingPdfExportDialog
        open onOpenChange={() => {}} displayedScale={100}
        sheetEnabled={false} activeSheet={null}
        onExport={(n) => calls.push(n)}
      />,
    );
    click(exportButton());
    assert.deepEqual(calls, [undefined]);
  });

  it('a preset scale sends its exact factor', () => {
    const calls: Array<number | undefined> = [];
    render(
      <DrawingPdfExportDialog
        open onOpenChange={() => {}} displayedScale={100}
        sheetEnabled={false} activeSheet={null}
        onExport={(n) => calls.push(n)}
      />,
    );
    chooseScale('1:50');
    click(exportButton());
    assert.deepEqual(calls, [50]);
  });

  it('a custom scale sends the number the user typed, not the mount-time default', () => {
    const calls: Array<number | undefined> = [];
    render(
      <DrawingPdfExportDialog
        open onOpenChange={() => {}} displayedScale={100}
        sheetEnabled={false} activeSheet={null}
        onExport={(n) => calls.push(n)}
      />,
    );
    chooseScale('Custom');
    const input = document.body.querySelector('input') as HTMLInputElement;
    assert.ok(input, 'the custom scale input must render');
    typeInto(input, '250');
    click(exportButton());
    assert.deepEqual(calls, [250]);
  });

  it('an invalid custom scale blocks export instead of sending NaN or 0', () => {
    const calls: Array<number | undefined> = [];
    render(
      <DrawingPdfExportDialog
        open onOpenChange={() => {}} displayedScale={100}
        sheetEnabled={false} activeSheet={null}
        onExport={(n) => calls.push(n)}
      />,
    );
    chooseScale('Custom');
    const input = document.body.querySelector('input') as HTMLInputElement;
    typeInto(input, '0');
    click(exportButton());
    assert.deepEqual(calls, [], 'a scale of 0 must not reach the exporter');
    assert.match(document.body.textContent ?? '', /Invalid scale/, 'the error must be stated');
  });

  it('sheet mode ignores the scale controls and exports with no scale argument, letting the sheet decide', () => {
    // `handleExportPDF` reads scale/paper off `activeSheet` itself in sheet
    // mode and ignores any `scaleFactor` argument (see useDrawingExport.ts) —
    // so the dialog must not offer a scale select that would silently do
    // nothing, and must call onExport with no argument.
    const calls: Array<number | undefined> = [];
    render(
      <DrawingPdfExportDialog
        open onOpenChange={() => {}} displayedScale={100}
        sheetEnabled activeSheet={sheetFixture()}
        onExport={(n) => calls.push(n)}
      />,
    );
    assert.equal(document.body.querySelector('[role="combobox"]'), null, 'no scale select in sheet mode');
    assert.match(document.body.textContent ?? '', /1:50/, "the sheet's own fixed scale must be stated");
    click(exportButton());
    assert.deepEqual(calls, [undefined]);
  });

  it('states the paper the PDF will use for both sheet and non-sheet mode', () => {
    render(
      <DrawingPdfExportDialog
        open onOpenChange={() => {}} displayedScale={100}
        sheetEnabled={false} activeSheet={null}
        onExport={() => {}}
      />,
    );
    assert.match(document.body.textContent ?? '', /fit the drawing/i);
    cleanup();

    render(
      <DrawingPdfExportDialog
        open onOpenChange={() => {}} displayedScale={100}
        sheetEnabled activeSheet={sheetFixture()}
        onExport={() => {}}
      />,
    );
    assert.match(document.body.textContent ?? '', /A3 Landscape/);
    assert.match(document.body.textContent ?? '', /420 x 297 mm/);
  });

  it('Cancel closes without exporting', () => {
    const calls: Array<number | undefined> = [];
    let openState = true;
    render(
      <DrawingPdfExportDialog
        open={openState} onOpenChange={(v) => { openState = v; }} displayedScale={100}
        sheetEnabled={false} activeSheet={null}
        onExport={(n) => calls.push(n)}
      />,
    );
    const cancelButton = [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel');
    assert.ok(cancelButton, 'the Cancel button must render');
    click(cancelButton);
    assert.deepEqual(calls, [], 'Cancel must not export');
    assert.equal(openState, false, 'Cancel must close the dialog');
  });
});
