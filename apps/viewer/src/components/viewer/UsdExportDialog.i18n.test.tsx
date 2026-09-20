/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `UsdExportDialog.tsx` reads the geometry-export-dialogs catalogue (#4918
 * slice: geometry export, `geometryExport.usd.*`). Same oracle shape as
 * `GLBExportDialog.i18n.test.tsx`, including inlining the expected
 * key/English-text pairs instead of importing the catalogue module at
 * runtime — see that file's docblock for why (the catalogue is new in this
 * slice, so reverting production deletes it, and a guarded import here
 * would let the revert-oracle see a skipped suite instead of a real
 * failure). `blurb`'s USD-attribute interpolation params (`upAxis`,
 * `metersPerUnit`, `xform`, `usdGeomMesh`, `usdPreviewSurface`,
 * `purposeGuide`) are technical identifiers the caller supplies verbatim,
 * not translated text, so this test only asserts the surrounding narrative
 * keys are marked, not the literal param values.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { useViewerStore } from '@/store';
import { UsdExportDialog } from './UsdExportDialog.js';

const STRINGS: Record<string, string> = {
  'geometryExport.usd.triggerButton': 'Export USD',
  'geometryExport.usd.dialogTitle': 'Export USD (OpenUSD)',
  'geometryExport.usd.outputLabel': 'Output',
  'geometryExport.usd.outputFormat': 'OpenUSD Stage',
  'geometryExport.usd.fileExtension': '.usda',
  'geometryExport.usd.noSourceTitle': 'No source available',
  'geometryExport.usd.noSourceDescription':
    'USD export needs the original IFC file. Re-open the model from disk to enable it.',
  'geometryExport.usd.cancelButton': 'Cancel',
  'geometryExport.usd.exportButton': 'Export',
};

// dialogDescription and blurb both carry `{param}` interpolation, so the
// pseudo-oracle only needs their key prefixes marked, not an exact-text
// match — asserted separately below via `startsWith` on the prefix.
const PSEUDO: Catalogue = {
  ...Object.fromEntries(Object.entries(STRINGS).map(([key, text]) => [key, `⟦${key}|${text}⟧`])),
  // These two carry `{param}` interpolation (a literal `.usda` extension, and
  // USD scene-description attribute names) — keep the placeholders live so
  // `resolve()` still fills them, just mark the template itself.
  'geometryExport.usd.dialogDescription': '⟦geometryExport.usd.dialogDescription|A real Z-up OpenUSD ASCII ({usdaExt}) stage for usdview / Blender / Omniverse⟧',
  'geometryExport.usd.blurb': '⟦geometryExport.usd.blurb|Emits a Z-up USD stage ({upAxis}, {metersPerUnit}) mirroring the IFC spatial hierarchy as {xform} prims, with {usdGeomMesh} geometry, {usdPreviewSurface} materials, and IFC metadata as custom attributes.⟧',
};
const PSEUDO_LOCALE = 'usd-export-pseudo';

function readable(): Set<string> {
  const out = new Set<string>();
  document.body.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) out.add(placeholder);
    const title = element.getAttribute('title');
    if (title) out.add(title);
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
  render(<UsdExportDialog />);
  const trigger = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(STRINGS['geometryExport.usd.triggerButton']),
  );
  assert.ok(trigger, 'export trigger button not found');
  click(trigger!);
}

const RESET = { models: new Map() } as Partial<ReturnType<typeof useViewerStore.getState>>;

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState(RESET);
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(RESET);
});

describe('UsdExportDialog localization (#4918)', () => {
  it('static dialog chrome: title, description, output, no-source state, and footer', () => {
    openDialog();
    const english = readable();
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readable();

    for (const [key, text] of Object.entries(STRINGS)) {
      assert.ok(english.has(text), `${key}: "${text}" expected visible in English before switching locale`);
      assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: must be translated, marked text not found`);
    }

    assert.ok(
      [...after].some((s) => s.startsWith('⟦geometryExport.usd.dialogDescription|')),
      'geometryExport.usd.dialogDescription: must be translated, marked text not found',
    );
    assert.ok(
      [...after].some((s) => s.startsWith('⟦geometryExport.usd.blurb|')),
      'geometryExport.usd.blurb: must be translated, marked text not found',
    );
  });
});
