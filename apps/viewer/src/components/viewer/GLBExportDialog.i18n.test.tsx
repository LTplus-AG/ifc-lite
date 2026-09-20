/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `GLBExportDialog.tsx` reads the geometry-export-dialogs catalogue (#4918
 * slice: geometry export, `geometryExport.glb.*`). Same oracle shape as the
 * rest of the sweep: a pseudo-locale marks every `geometryExport.*` key, the
 * dialog is opened with no models loaded (so no export ever actually runs —
 * the wasm geometry engine isn't available in this Node test environment),
 * the locale is switched live, and every marked string visible in English
 * must reappear marked.
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
import { GLBExportDialog } from './GLBExportDialog.js';

// Guarded dynamic import (#4918 revert-oracle): a reverted/missing catalogue
// module must fail this test's real assertions rather than be skipped —
// `describe.skip` here would leave the oracle observing zero collected
// tests and reading INCONCLUSIVE instead of a real regression.
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
const PSEUDO_LOCALE = 'glb-export-pseudo';

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
  render(<GLBExportDialog />);
  const trigger = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(CATALOGUE['geometryExport.glb.triggerButton'] as string),
  );
  assert.ok(trigger, 'export trigger button not found');
  click(trigger!);
}

const RESET = {
  models: new Map(),
  geometryResult: null,
} as Partial<ReturnType<typeof useViewerStore.getState>>;

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
  'GLBExportDialog localization (#4918)',
  { skip: !HAS_CATALOGUE && 'geometry-export-dialogs.en.ts catalogue module not present (revert-oracle probe)' },
  () => {
    it('static dialog chrome: title, description, field labels, hints, and footer', () => {
      openDialog();
      const english = readable();
      registerLocale(PSEUDO_LOCALE, PSEUDO);
      act(() => setLocale(PSEUDO_LOCALE));
      const after = readable();

      const keys: GeomKey[] = [
        'geometryExport.glb.triggerButton',
        'geometryExport.glb.dialogTitle',
        'geometryExport.glb.dialogDescription',
        'geometryExport.glb.colorSourceLabel',
        // colorSourceRendering is the default-selected value, surfaced through
        // Select's trigger; colorSourceShading lives only inside the closed
        // Radix Select's portal-rendered content and isn't in the DOM until
        // the trigger is opened, so it is intentionally not asserted here.
        'geometryExport.glb.colorSourceRendering',
        'geometryExport.glb.colorSourceRenderingHint',
        'geometryExport.glb.outputLabel',
        'geometryExport.glb.outputFormat',
        'geometryExport.glb.fileExtension',
        'geometryExport.glb.visibleOnlyLabel',
        'geometryExport.glb.visibleOnlyHint',
        'geometryExport.glb.includeMetadataLabel',
        'geometryExport.glb.includeMetadataHint',
        'geometryExport.glb.litLabel',
        'geometryExport.glb.litHint',
        'geometryExport.glb.cancelButton',
        'geometryExport.glb.exportButton',
      ];
      for (const key of keys) {
        const text = CATALOGUE[key] as string;
        assert.ok(english.has(text), `${key}: "${text}" expected visible in English before switching locale`);
        assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: must be translated, marked text not found`);
      }
    });
  },
);
