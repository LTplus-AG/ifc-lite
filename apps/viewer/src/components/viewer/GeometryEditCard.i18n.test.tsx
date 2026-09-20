/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `GeometryEditCard.tsx` reads the geometry-export-dialogs catalogue (#4918
 * slice: geometry export, `geometryExport.editCard.*` — grouped into the
 * same catalogue file as the four sibling export dialogs purely because it
 * is a small slice sibling, not because it shares any export machinery).
 * Same oracle shape as the rest of the sweep: a pseudo-locale marks every
 * `geometryExport.*` key, the card is rendered against a model id with no
 * registered model (so Move stays disabled and rotation/split stay hidden —
 * the same "no model" shape every mutation reader in this store falls back
 * to safely), the locale is switched live, and every marked string visible
 * in English must reappear marked.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { geometryExportDialogsEn as GeometryExportEnType } from '@/i18n/catalogues/geometry-export-dialogs.en';
import { useViewerStore } from '@/store';
import { GeometryEditCard } from './GeometryEditCard.js';

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
const PSEUDO_LOCALE = 'geometry-edit-card-pseudo';

function readable(): Set<string> {
  const out = new Set<string>();
  document.body.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
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

const RESET = { models: new Map(), mutationViews: new Map() } as Partial<ReturnType<typeof useViewerStore.getState>>;

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
  'GeometryEditCard localization (#4918)',
  { skip: !HAS_CATALOGUE && 'geometry-export-dialogs.en.ts catalogue module not present (revert-oracle probe)' },
  () => {
    it('header, non-standard-placement hint, nudge control, and duplicate/delete actions', () => {
      render(<GeometryEditCard modelId="no-such-model" entityId={42} entityLabel="IfcWall #42" />);
      const english = readable();
      registerLocale(PSEUDO_LOCALE, PSEUDO);
      act(() => setLocale(PSEUDO_LOCALE));
      const after = readable();

      const keys: GeomKey[] = [
        'geometryExport.editCard.header',
        'geometryExport.editCard.positionSectionLabel',
        'geometryExport.editCard.nudgeStepAriaLabel',
        'geometryExport.editCard.nonStandardPlacementHint',
        // duplicateTooltip / deleteTooltip live in Radix Tooltip's
        // portal-rendered content, which only mounts on hover/focus — not
        // asserted here, same reasoning as the Select-content exclusion in
        // GLBExportDialog.i18n.test.tsx.
        'geometryExport.editCard.duplicateButton',
        'geometryExport.editCard.deleteButton',
      ];
      for (const key of keys) {
        const text = CATALOGUE[key] as string;
        assert.ok(english.has(text), `${key}: "${text}" expected visible in English before switching locale`);
        assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: must be translated, marked text not found`);
      }

      // The nudge-step <option> text carries the ±{step} m interpolation —
      // asserted as a substring since the option renders "±0.1 m" etc.
      const nudgeOptionKey: GeomKey = 'geometryExport.editCard.nudgeStepOption';
      assert.ok(
        [...after].some((s) => s.startsWith(`⟦${nudgeOptionKey}|`)),
        `${nudgeOptionKey}: must be translated, marked text not found`,
      );
    });
  },
);
