/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RepositionPanel`'s own chrome reads the i18n catalogue (#4918 slice,
 * `reposition-panel.en.ts`, prefix `repositionPanel.*`): the header,
 * moving/reference model pickers, framing shortcuts, point-picking
 * prompts, constraint/input-mode controls, the move-dimensions readout,
 * and the apply/undo/redo/reset actions. `RotationControls.tsx`,
 * `PlacementGizmo.tsx`, `PlacementFiles.tsx`, and
 * `StaleMeasurementBadge.tsx` share the same catalogue and prefix; this
 * file covers the panel's own default-visible chrome plus the
 * lock-toggle and mode-switch states that only a real interaction
 * reveals, the sibling files' own dedicated coverage is not repeated here.
 *
 * The oracle is a pseudo-locale that marks every `repositionPanel.*` key
 * with a `⟦…⟧` wrapper; the real English text (computed through
 * `resolve()`, never hardcoded here) must be on screen before the switch,
 * and the marked form must reappear after it. Model NAMES are runtime
 * content and are asserted separately from the catalogue keys.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { en } from '@/i18n/en';
import type { TranslationParameters, TranslationValue, PluralTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types.js';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { RepositionPanel } from './RepositionPanel';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('repositionPanel.')),
);
const KEYS = Object.keys(CATALOGUE) as (keyof typeof CATALOGUE)[];

function markValue(value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${value}⟧`;
  const marked: Record<string, string> = {};
  for (const [category, text] of Object.entries(value as PluralTranslation)) {
    if (typeof text === 'string') marked[category] = `⟦${text}⟧`;
  }
  return marked as PluralTranslation;
}

const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, markValue(CATALOGUE[key]!)]));
const BASELINE_LOCALE = 'en';
const PSEUDO_LOCALE = 'reposition-panel-pseudo';

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

interface Occurrence {
  key: string;
  params?: TranslationParameters;
}

function assertAllTranslate(occurrences: Occurrence[], englishDom: Set<string>, afterDom: Set<string>): void {
  for (const occ of occurrences) {
    const english = resolve(occ.key as never, occ.params).trim();
    assert.ok(
      englishDom.has(english),
      `${occ.key}: expected English text ${JSON.stringify(english)} to be on screen before the locale switch`,
    );
  }
  act(() => setLocale(PSEUDO_LOCALE));
  try {
    for (const occ of occurrences) {
      const pseudo = resolve(occ.key as never, occ.params).trim();
      assert.ok(
        afterDom.has(pseudo),
        `${occ.key}: "${pseudo}" must be translated, marked text not found in the switched-locale DOM`,
      );
    }
  } finally {
    act(() => setLocale(BASELINE_LOCALE));
  }
}

function domAfterPseudo(container: ParentNode): Set<string> {
  act(() => setLocale(PSEUDO_LOCALE));
  const set = readableStrings(container);
  act(() => setLocale(BASELINE_LOCALE));
  return set;
}

function federatedModel(id: string, name: string): FederatedModel {
  return {
    id, name, ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
    schemaVersion: 'IFC4', loadedAt: 1, fileSize: 0, idOffset: 0, maxExpressId: 0,
  } as FederatedModel;
}

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({
    models: new Map([['a', federatedModel('a', 'Alpha.ifc')], ['b', federatedModel('b', 'Beta.ifc')]]),
    modelPlacement: emptyPlacementState(),
    repositionNudge: 0.001,
    snapEnabled: true,
    cameraCallbacks: {},
  });
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({
    models: new Map(), modelPlacement: emptyPlacementState(), repositionNudge: 0.001,
    snapEnabled: true, cameraCallbacks: {},
  });
});

describe('RepositionPanel localization (#4918)', () => {
  it('translates the panel header, model pickers, framing shortcuts, and the idle prompt', async () => {
    const container = render(<RepositionPanel />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'repositionPanel.title' },
        { key: 'repositionPanel.cancelAriaLabel' },
        { key: 'repositionPanel.cancelButton' },
        { key: 'repositionPanel.subtitle' },
        { key: 'repositionPanel.movingModelsLegend' },
        { key: 'repositionPanel.referenceModelLabel' },
        { key: 'repositionPanel.chooseReferenceOption' },
        { key: 'repositionPanel.frameMovingButton' },
        { key: 'repositionPanel.frameReferenceButton' },
        { key: 'repositionPanel.frameBothButton' },
        { key: 'repositionPanel.moveNearReferenceButton' },
        { key: 'repositionPanel.moveNearNote' },
        { key: 'repositionPanel.pickSourceButton' },
        { key: 'repositionPanel.pickTargetButton' },
        { key: 'repositionPanel.snapLabel' },
        { key: 'repositionPanel.previewPrompt' },
        { key: 'repositionPanel.constraintLabel' },
        { key: 'repositionPanel.movementConstraintAriaLabel' },
        { key: 'repositionPanel.inputLabel' },
        { key: 'repositionPanel.coordinateInputModeAriaLabel' },
        { key: 'repositionPanel.deltaModeOption' },
        { key: 'repositionPanel.absoluteModeOption' },
        { key: 'repositionPanel.previewValuesButton' },
        { key: 'repositionPanel.distanceLabel' },
        { key: 'repositionPanel.moveDistanceAriaLabel' },
        { key: 'repositionPanel.previewDistanceButton' },
        { key: 'repositionPanel.moveDimensionsAriaLabel' },
        { key: 'repositionPanel.moveOutput', params: { distance: '0.0000', dx: '0.0000', dy: '0.0000', dz: '0.0000' } },
        { key: 'repositionPanel.nudgeIncrementLabel' },
        { key: 'repositionPanel.keyboardHelp' },
        { key: 'repositionPanel.applyButton' },
        { key: 'repositionPanel.undoButton' },
        { key: 'repositionPanel.redoButton' },
        { key: 'repositionPanel.resetButton' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates the lock toggle action and status once a model is selected', async () => {
    const container = render(<RepositionPanel />);
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    assert.ok(checkbox, 'expected a moving-model checkbox');
    click(checkbox);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'repositionPanel.statusUnlocked' },
        { key: 'repositionPanel.modelPositionRow', params: { name: 'Alpha.ifc', values: '0.0000, 0.0000, 0.0000' } },
      ],
      englishDom,
      afterDom,
    );
    // The lock-toggle aria-label nests a second `t()` call for the action
    // word, so its pseudo form has to be computed the same way the
    // component computes it — not from a param captured before the switch.
    const englishAriaLabel = resolve('repositionPanel.toggleLockAriaLabel' as never, {
      action: resolve('repositionPanel.lockAction' as never),
      name: 'Alpha.ifc',
    });
    assert.ok(englishDom.has(englishAriaLabel), 'expected the English lock-toggle aria-label before the locale switch');
    act(() => setLocale(PSEUDO_LOCALE));
    const pseudoAriaLabel = resolve('repositionPanel.toggleLockAriaLabel' as never, {
      action: resolve('repositionPanel.lockAction' as never),
      name: 'Alpha.ifc',
    });
    const pseudoDom = readableStrings(container);
    act(() => setLocale(BASELINE_LOCALE));
    assert.ok(pseudoDom.has(pseudoAriaLabel), 'expected the marked lock-toggle aria-label after the locale switch');
  });
});
