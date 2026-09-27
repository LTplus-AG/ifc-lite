/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExportDialog.tsx` reads the i18n catalogue (#4918 slice: export/panel
 * outer chrome, `export-dialog.en.ts`) — see that file's own docblock for
 * the exact surface. This suite drives the dialog open with the default
 * (no model loaded) store state, so it covers the always-rendered chrome:
 * the trigger, title/description, model/schema selectors, the option
 * switches and their hints, and the footer controls. The schema-conversion
 * warning, the pending-changes banner, and the export-progress/result
 * states need a loaded model / an in-flight export to render and are left
 * to manual verification, same reasoning `ClashSettingsDialog.i18n.test.tsx`
 * gives for its own `NOT_RENDERED` keys.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { exportDialogEn as ExportDialogEnType } from '@/i18n/catalogues/export-dialog.en';
import { ExportDialog } from './ExportDialog.js';

// Guarded dynamic import (#4918 revert-oracle): a revert of this slice's
// production change deletes `export-dialog.en.ts` entirely, and a static
// `import { exportDialogEn } from '...'` would fail this whole file's LOAD
// (ERR_MODULE_NOT_FOUND) instead of letting the assertions below fail on
// their own merits. The `describe`/`it` below are deliberately NOT skipped
// when the catalogue is absent: `openDialog()`'s trigger lookup and every
// `CATALOGUE[key]` read go `undefined`, so `assert.ok(trigger, ...)` and
// `assert.equal(typeof text, 'string')` go red on their own — a real
// ASSERTION_FAILURE the revert-oracle can attribute, rather than a
// `describe.skip` collecting zero tests (NO_TESTS), which the oracle cannot
// distinguish from a broken harness (#4918 revert-oracle lesson).
let exportDialogEnLoaded: typeof ExportDialogEnType | undefined;
try {
  ({ exportDialogEn: exportDialogEnLoaded } = await import('@/i18n/catalogues/export-dialog.en'));
} catch {
  exportDialogEnLoaded = undefined;
}
const CATALOGUE: typeof ExportDialogEnType = exportDialogEnLoaded ?? ({} as typeof ExportDialogEnType);

type ExportDialogKey = keyof typeof CATALOGUE;

function markValue(key: string, value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${key}|${value}⟧`;
  const wrapped: Record<string, string> = {};
  for (const [category, text] of Object.entries(value)) wrapped[category] = `⟦${key}|${text}⟧`;
  return wrapped as TranslationValue;
}
const PSEUDO: Catalogue = Object.fromEntries(
  Object.keys(CATALOGUE).map((key) => [key, markValue(key, CATALOGUE[key as ExportDialogKey])]),
);
const PSEUDO_LOCALE = 'export-dialog-pseudo';

function readable(): Set<string> {
  const out = new Set<string>();
  document.body.querySelectorAll('*').forEach((element) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(attr);
      if (value) out.add(value);
    }
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

function openDialog(): void {
  render(<ExportDialog />);
  const trigger = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.includes(CATALOGUE['exportDialog.trigger'] as string),
  );
  assert.ok(trigger, 'export trigger button not found');
  click(trigger!);
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('ExportDialog localization (#4918)', () => {
  it('translates the trigger, dialog chrome, selectors, option switches, and footer', () => {
    openDialog();
    const english = readable();
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readable();
    act(() => setLocale('en'));

    const keys: ExportDialogKey[] = [
      'exportDialog.trigger',
      'exportDialog.title',
      'exportDialog.description.default',
      'exportDialog.modelLabel',
      'exportDialog.selectModelPlaceholder',
      'exportDialog.schemaLabel',
      'exportDialog.outputLabel',
      'exportDialog.visibleOnlyLabel',
      'exportDialog.visibleOnlyHint',
      'exportDialog.includeGeometryLabel',
      'exportDialog.applyMutationsLabel',
      'exportDialog.changesOnlyLabel.default',
      'exportDialog.changesOnlyHint.default',
      'exportDialog.cancelButton',
      'exportDialog.exportButton',
    ];
    for (const key of keys) {
      const text = CATALOGUE[key] as string;
      assert.equal(typeof text, 'string');
      assert.ok(english.has(text), `${key}: "${text}" expected visible in English before switching locale`);
      assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: must be translated, marked text not found`);
    }
  });
});
