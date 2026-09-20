/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `UsdExportDialog.tsx` reads the geometry-export-dialogs catalogue (#4918
 * slice: geometry export, `geometryExport.usd.*`). Same oracle shape as
 * `GLBExportDialog.i18n.test.tsx`: a pseudo-locale marks every
 * `geometryExport.*` key, the dialog is opened with no models loaded, the
 * locale is switched live, and every marked string visible in English must
 * reappear marked. `blurb`'s USD-attribute interpolation params (`upAxis`,
 * `metersPerUnit`, `xform`, `usdGeomMesh`, `usdPreviewSurface`,
 * `purposeGuide`) are technical identifiers the caller supplies verbatim,
 * not translated text, so this test only asserts the surrounding narrative
 * key itself is marked, not the literal param values.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { geometryExportDialogsEn as GeometryExportEnType } from '@/i18n/catalogues/geometry-export-dialogs.en';
import { useViewerStore } from '@/store';
import { UsdExportDialog } from './UsdExportDialog.js';

let catalogueLoaded: typeof GeometryExportEnType | undefined;
try {
  ({ geometryExportDialogsEn: catalogueLoaded } = await import('@/i18n/catalogues/geometry-export-dialogs.en'));
} catch {
  catalogueLoaded = undefined;
}
const HAS_CATALOGUE = catalogueLoaded !== undefined;
const CATALOGUE: typeof GeometryExportEnType = catalogueLoaded ?? ({} as typeof GeometryExportEnType);

type GeomKey = keyof typeof CATALOGUE;

function markValue(key: string, value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${key}|${value}⟧`;
  const wrapped: Record<string, string> = {};
  for (const [category, text] of Object.entries(value)) wrapped[category] = `⟦${key}|${text}⟧`;
  return wrapped as TranslationValue;
}
const PSEUDO: Catalogue = Object.fromEntries(
  Object.keys(CATALOGUE).map((key) => [key, markValue(key, CATALOGUE[key as GeomKey])]),
);
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
    b.textContent?.includes(CATALOGUE['geometryExport.usd.triggerButton'] as string),
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

describe(
  'UsdExportDialog localization (#4918)',
  { skip: !HAS_CATALOGUE && 'geometry-export-dialogs.en.ts catalogue module not present (revert-oracle probe)' },
  () => {
    it('static dialog chrome: title, description, output, no-source state, and footer', () => {
      openDialog();
      const english = readable();
      registerLocale(PSEUDO_LOCALE, PSEUDO);
      act(() => setLocale(PSEUDO_LOCALE));
      const after = readable();

      const keys: GeomKey[] = [
        'geometryExport.usd.triggerButton',
        'geometryExport.usd.dialogTitle',
        'geometryExport.usd.outputLabel',
        'geometryExport.usd.outputFormat',
        'geometryExport.usd.fileExtension',
        'geometryExport.usd.noSourceTitle',
        'geometryExport.usd.noSourceDescription',
        'geometryExport.usd.cancelButton',
        'geometryExport.usd.exportButton',
      ];
      for (const key of keys) {
        const text = CATALOGUE[key] as string;
        assert.ok(english.has(text), `${key}: "${text}" expected visible in English before switching locale`);
        assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: must be translated, marked text not found`);
      }

      // dialogDescription and blurb carry interpolation params (the literal
      // ".usda" extension and USD scene-description attribute names) — assert
      // the surrounding translated text is marked without pinning the exact
      // literal params.
      assert.ok(
        [...after].some((s) => s.startsWith('⟦geometryExport.usd.dialogDescription|')),
        'geometryExport.usd.dialogDescription: must be translated, marked text not found',
      );
      assert.ok(
        [...after].some((s) => s.startsWith('⟦geometryExport.usd.blurb|')),
        'geometryExport.usd.blurb: must be translated, marked text not found',
      );
    });
  },
);
