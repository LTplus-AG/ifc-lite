/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `GeometryEditCard.tsx` reads the geometry-export-dialogs catalogue (#4918
 * slice: geometry export, `geometryExport.editCard.*` — grouped into the
 * same catalogue file as the four sibling export dialogs purely because it
 * is a small slice sibling, not because it shares any export machinery).
 * Same oracle shape as `GLBExportDialog.i18n.test.tsx`, including inlining
 * the expected key/English-text pairs instead of importing the catalogue
 * module at runtime — see that file's docblock for why (the catalogue is
 * new in this slice, so reverting production deletes it, and a guarded
 * import here would let the revert-oracle see a skipped suite instead of a
 * real failure). The card is rendered against a model id with no
 * registered model, so Move stays disabled and rotation/split stay
 * hidden — the same "no model" shape every mutation reader in this store
 * falls back to safely.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { useViewerStore } from '@/store';
import { GeometryEditCard } from './GeometryEditCard.js';

const STRINGS: Record<string, string> = {
  'geometryExport.editCard.header': 'Geometry',
  'geometryExport.editCard.positionSectionLabel': 'Storey-local position (IFC Z-up)',
  'geometryExport.editCard.nudgeStepAriaLabel': 'Nudge step in metres',
  'geometryExport.editCard.nonStandardPlacementHint':
    "Entity has a non-standard placement (mapped representation or 2D-only). Move isn't supported directly — Duplicate and Delete still work.",
  // duplicateTooltip / deleteTooltip live in Radix Tooltip's
  // portal-rendered content, which only mounts on hover/focus — not
  // asserted here, same reasoning as the Select-content exclusion in
  // GLBExportDialog.i18n.test.tsx.
  'geometryExport.editCard.duplicateButton': 'Duplicate',
  'geometryExport.editCard.deleteButton': 'Delete',
};

const PSEUDO: Catalogue = {
  ...Object.fromEntries(Object.entries(STRINGS).map(([key, text]) => [key, `⟦${key}|${text}⟧`])),
  // Carries the `±{step} m` interpolation — mark the template, keep the
  // placeholder live.
  'geometryExport.editCard.nudgeStepOption': '⟦geometryExport.editCard.nudgeStepOption|±{step} m⟧',
};
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

describe('GeometryEditCard localization (#4918)', () => {
  it('header, non-standard-placement hint, nudge control, and duplicate/delete actions', () => {
    render(<GeometryEditCard modelId="no-such-model" entityId={42} entityLabel="IfcWall #42" />);
    const english = readable();
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readable();

    for (const [key, text] of Object.entries(STRINGS)) {
      assert.ok(english.has(text), `${key}: "${text}" expected visible in English before switching locale`);
      assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: must be translated, marked text not found`);
    }

    // The nudge-step <option> text carries the ±{step} m interpolation —
    // asserted as a substring since the option renders "±0.1 m" etc.
    assert.ok(
      [...after].some((s) => s.startsWith('⟦geometryExport.editCard.nudgeStepOption|')),
      'geometryExport.editCard.nudgeStepOption: must be translated, marked text not found',
    );
  });
});
