/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, type, press, cleanup } from '@/test/render.js';
import { AppearancePdfFields, AppearancePdfPassword } from './AppearancePdfFields.js';
import { AppearanceSourceFields } from './AppearanceSourceFields.js';
import type { AppearancePdfControls } from './pdf-controls.js';
import type { PdfRect } from '@/lib/appearance/pdf/types.js';

afterEach(cleanup);
function pdf(patch: Partial<AppearancePdfControls> = {}): AppearancePdfControls {
  return {
    documentId: 'document-1', documentName: 'Survey.pdf', pageCount: 3, pageNumber: 1,
    rotation: 0, pageSizePoints: [720, 360], cropPoints: [0, 0, 720, 360], requestedDpi: 144,
    onPageChange() {}, onRotationChange() {}, onCropChange() {}, onDpiChange() {}, ...patch,
  };
}
function input(ui: HTMLElement, label: string): HTMLInputElement {
  const element = ui.querySelector(`input[aria-label="${label}"]`);
  assert.ok(element instanceof HTMLInputElement); return element;
}
function button(ui: HTMLElement, label: string): HTMLButtonElement {
  const element = [...ui.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') ?? node.textContent) === label);
  assert.ok(element instanceof HTMLButtonElement); return element;
}
function select(ui: HTMLElement, label: string, value: string) {
  const element = ui.querySelector(`select[aria-label="${label}"]`);
  assert.ok(element instanceof HTMLSelectElement);
  act(() => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); });
}

it('supports page navigation and commits a typed page on Enter, rejecting out-of-range pages (#4260)', () => {
  const pages: number[] = []; const invalid: boolean[] = [];
  const ui = render(<AppearancePdfFields pdf={pdf({ onPageChange: page => pages.push(page) })} disabled={false} onInvalid={(_, value) => invalid.push(value)} />);
  assert.equal(button(ui, 'Previous PDF page').disabled, true);
  click(button(ui, 'Next PDF page')); assert.deepEqual(pages, [2]);
  const number = input(ui, 'PDF page number'); type(number, '3');
  assert.deepEqual(pages, [2]); press(number, 'Enter'); assert.deepEqual(pages, [2, 3]);
  type(number, '4'); press(number, 'Enter'); assert.deepEqual(pages, [2, 3]);
  assert.equal(invalid.at(-1), true); assert.match(ui.textContent ?? '', /Choose a page from 1 to 3/);
});

it('keeps rotation and quality separate from paper size and reports effective DPI (#4260)', () => {
  const rotations: number[] = []; const dpis: number[] = []; const crops: PdfRect[] = [];
  const ui = render(<AppearancePdfFields pdf={pdf({ effectiveDpi: 96, onRotationChange: n => rotations.push(n), onDpiChange: n => dpis.push(n), onCropChange: crop => crops.push(crop) })} disabled={false} onInvalid={() => {}} />);
  select(ui, 'PDF page rotation', '90'); select(ui, 'PDF image quality', '300');
  assert.deepEqual(rotations, [90]); assert.deepEqual(dpis, [300]); assert.deepEqual(crops, []);
  assert.match(ui.textContent ?? '', /Rendered at 96 dpi.*Paper size is unchanged/);
});

it('converts paper-mm margins to the existing physical-point crop contract and rejects empty crops (#4260)', () => {
  const crops: PdfRect[] = []; const invalid: boolean[] = [];
  const ui = render(<AppearancePdfFields pdf={pdf({ onCropChange: crop => crops.push(crop) })} disabled={false} onInvalid={(_, value) => invalid.push(value)} />);
  type(input(ui, 'PDF crop left margin (mm)'), '25.4');
  assert.deepEqual(crops.at(-1), [72, 0, 648, 360]);
  type(input(ui, 'PDF crop right margin (mm)'), '254');
  assert.equal(crops.length, 1); assert.equal(invalid.at(-1), true);
  click(button(ui, 'Use full page')); assert.deepEqual(crops.at(-1), [0, 0, 720, 360]);
});

it('commits a reverse-direction crop gesture once and supports pointer cancellation (#4260)', () => {
  const crops: PdfRect[] = [];
  const ui = render(<AppearancePdfFields pdf={pdf({ pagePreviewUrl: 'data:image/png;base64,', onCropChange: crop => crops.push(crop) })} disabled={false} onInvalid={() => {}} />);
  const preview = ui.querySelector('[aria-label="PDF crop preview"]'); assert.ok(preview instanceof HTMLDivElement);
  Object.defineProperty(preview, 'getBoundingClientRect', { value: () => new DOMRect(10, 20, 200, 100) });
  const pointer = (event: string, x: number, y: number) => act(() => {
    preview.dispatchEvent(new window.PointerEvent(event, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
  });
  pointer('pointerdown', 160, 95); pointer('pointermove', 60, 45);
  assert.equal(crops.length, 0); pointer('pointerup', 60, 45);
  assert.deepEqual(crops, [[180, 90, 360, 180]]);
  pointer('pointerdown', 20, 30); pointer('pointermove', 150, 90); pointer('pointercancel', 150, 90);
  pointer('pointerup', 150, 90); assert.equal(crops.length, 1);
});

it('gates PDF upload capability and forwards the actual File without a second importer (#4260)', () => {
  const uploaded: File[] = [];
  const imageOnly = render(<AppearanceSourceFields sources={[]} sourceId={null} onSourceChange={() => {}} onUpload={() => {}} disabled={false} />);
  assert.doesNotMatch(input(imageOnly, 'Upload appearance image').accept, /pdf/);
  const ui = render(<AppearanceSourceFields allowPdf sources={[]} sourceId={null} onSourceChange={() => {}} onUpload={file => uploaded.push(file)} disabled={false} />);
  const picker = input(ui, 'Upload appearance source'); assert.match(picker.accept, /application\/pdf/);
  const file = new File(['%PDF-1.7'], 'Survey.pdf', { type: 'application/pdf' });
  const transfer = new window.DataTransfer(); transfer.items.add(file);
  Object.defineProperty(picker, 'files', { value: transfer.files });
  act(() => picker.dispatchEvent(new Event('change', { bubbles: true })));
  assert.equal(uploaded[0], file); assert.equal(picker.value, '');
});

it('submits passwords exactly once, clears the input, and keeps retry/cancel visible (#4260)', () => {
  const submitted: string[] = []; let cancelled = false;
  const ui = render(<AppearancePdfPassword prompt={{ documentName: 'Survey.pdf', incorrect: true, onSubmit: value => submitted.push(value), onCancel: () => { cancelled = true; } }} disabled={false} />);
  const field = input(ui, 'PDF password'); assert.equal(field.type, 'password');
  type(field, ' exact password ');
  const form = ui.querySelector('form'); assert.ok(form);
  act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(submitted, [' exact password ']); assert.equal(field.value, '');
  assert.equal(button(ui, 'Unlock PDF').disabled, true);
  assert.match(ui.textContent ?? '', /That password did not unlock/);
  click(button(ui, 'Cancel')); assert.equal(cancelled, true);
});
