/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AnonymizedExportDialog`'s own chrome reads the i18n catalogue (#4918
 * slice: anonymized export, `anonymized-export.en.ts`): the dialog
 * title/description, the no-selection prompt, and the footer's file-name
 * label/extension/cancel/export controls. The dialog's fuller
 * has-selection state (relationship toggles, type chips, related-entity
 * list) is owned by `AnonymizationOptionsPanel`/`RelationTogglePanel`/
 * `RelatedEntityList`/`TypeCategoryBar`, each pure enough to exercise
 * without mounting the whole dialog and its `useAnonymizedExportSet`
 * selection-latching machinery — this file proves the dialog's own
 * always-rendered chrome instead.
 *
 * Dynamic + guarded import (not a static one): a revert of this slice's
 * production change deletes `anonymized-export.en.ts` entirely, and a
 * static `import { anonymizedExportEn } from '...'` would fail this whole
 * test FILE to load (ERR_MODULE_NOT_FOUND) instead of letting the
 * assertions below fail on their own merits. The `describe` block itself is
 * deliberately NOT skipped when the catalogue is absent: every
 * `CATALOGUE[key]` lookup below would return `undefined`, so
 * `assert.equal(typeof value, 'string')` goes red on its own — a real
 * ASSERTION_FAILURE the revert-oracle can attribute, rather than a
 * `describe.skip` collecting zero tests (NO_TESTS), which the oracle cannot
 * distinguish from a broken harness (#4918 revert-oracle lesson).
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { anonymizedExportEn as AnonymizedExportEnType } from '@/i18n/catalogues/anonymized-export.en';
import { useViewerStore } from '@/store';
import { AnonymizedExportDialog } from './AnonymizedExportDialog.js';

let anonymizedExportEn: typeof AnonymizedExportEnType | undefined;
try {
  ({ anonymizedExportEn } = await import('@/i18n/catalogues/anonymized-export.en'));
} catch {
  anonymizedExportEn = undefined;
}
const CATALOGUE = anonymizedExportEn ?? ({} as typeof AnonymizedExportEnType);

const marked = (text: string): string => `⟦${text}⟧`;

function pseudoLocale(): Catalogue {
  const catalogue: Record<string, TranslationValue> = {};
  for (const [key, value] of Object.entries(CATALOGUE) as [string, TranslationValue][]) {
    catalogue[key] = typeof value === 'string' ? marked(value) : { one: marked(value.one ?? value.other), other: marked(value.other) };
  }
  return catalogue;
}

const PSEUDO_LOCALE = 'anonymized-export-dialog-pseudo';

function readableStrings(root: ParentNode): Set<string> {
  const out = new Set<string>();
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value) out.add(value);
    }
    const ownText = [...el.childNodes]
      .filter((n) => n.nodeType === n.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState({ anonymizedExportRequested: true, selectedEntityIds: new Set<number>(), selectedEntity: null });
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({ anonymizedExportRequested: false });
});

describe('AnonymizedExportDialog localization (#4918)', () => {
  it('translates the title, description, no-selection prompt, and footer chrome', () => {
    // Trigger-less host instance: opens via the store's
    // `anonymizedExportRequested` flag, same as `ViewerLayout.tsx`'s
    // "Global Overlays" mount — see the component's own docblock.
    const container = render(<AnonymizedExportDialog />);
    const english = readableStrings(document.body);

    registerLocale(PSEUDO_LOCALE, pseudoLocale());
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readableStrings(document.body);
    act(() => setLocale('en'));

    for (const key of [
      'anonymizedExport.dialog.title',
      'anonymizedExport.dialog.description',
      'anonymizedExport.dialog.noSelectionPrompt',
      'anonymizedExport.dialog.fileNameLabel',
      'anonymizedExport.dialog.ifcExtensionSuffix',
      'anonymizedExport.dialog.cancelButton',
      'anonymizedExport.dialog.exportButtonLabel',
    ] as const) {
      const value = CATALOGUE[key];
      assert.equal(typeof value, 'string');
      assert.ok(english.has(value as string), `${key}: expected English text on screen before switch`);
      assert.ok(after.has(marked(value as string)), `${key}: expected marked text after switching locale`);
    }
    assert.ok(container, 'dialog container must render');
  });
});
