/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Driving `ExportDialog`'s scope selector, shared by the two suites that test
 * the two halves of one rule: `ExportDialog.merge-skips.test.tsx` (a tabular
 * store with no records is skipped and named) and
 * `ExportDialog.portable-room.test.tsx` (a shared room's portable STEP source
 * exempts it). They are the pair most likely to disagree, so the Radix
 * keyboard sequence that opens the scope combobox lives here once rather than
 * in both.
 *
 * Not itself a `.test.*` file, so it carries no tests — fixture support,
 * imported by the files that do.
 */

import assert from 'node:assert/strict';
import { advance, click, press } from '@/test/render';

/** The dialog shell's rendered text, however deeply Radix portals it. */
export const shellText = (): string =>
  document.querySelector('[data-export-dialog-shell]')?.textContent ?? '';

/** Open the dialog from the trigger whose label contains `label`. */
export const openExportDialog = (ui: HTMLElement, label: string): void =>
  click([...ui.querySelectorAll('button')].find(node => node.textContent?.includes(label))!);

/** The dialog's Export button, so a test can read `disabled` before clicking. */
export function exportButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Export');
  // Named, like ExportDialog.landxml.test.tsx's copy: a cast would fail the
  // next line with "cannot read properties of undefined" instead.
  assert.ok(button, 'the dialog renders its export action');
  return button;
}

/** Switch the scope select from its single-model default to merged. */
export async function chooseMerged(): Promise<void> {
  const scope = [...document.querySelectorAll('[role="combobox"]')].find(node => node.textContent?.includes('Single Model'));
  assert.ok(scope, 'the scope selector is offered for a federation');
  press(scope, 'ArrowDown'); await advance(10);
  const merged = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes('Merged (All Models)'));
  assert.ok(merged);
  click(merged); await advance(10);
}
