/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Split tool's own two overlays (#4918) read the i18n catalogue.
 *
 * The oracle is a pseudo-locale that maps every `splitTool.*` key to a
 * marked copy of its English text. `SplitNumericInput` is rendered in its
 * single-click-element "aiming" state (surfaces the metres/percent mode
 * toggle, the "of {length}m" readout, the Cut button and the Snap row);
 * `SplitOverlay` is rendered in its idle hint-chip state (armed, nothing
 * hovered yet). The locale is switched live and every marked string that
 * was readable in English must reappear marked.
 *
 * `split-tool.en.ts` is not yet imported into `en.ts` (#4918's integration
 * pass wires every new slice catalogue in afterward, in one place, to
 * avoid concurrent edits to the shared file). Until then the default 'en'
 * locale doesn't carry these keys, so this file merges the catalogue onto
 * the live (unfrozen) `en` object at module scope before any render —
 * verification-only, touches no file on disk.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { en } from '@/i18n/en';
import type { splitToolEn as SplitToolEnType } from '@/i18n/catalogues/split-tool.en';
import { useViewerStore } from '@/store';
import { SplitNumericInput } from './SplitNumericInput.js';
import { SplitOverlay } from './SplitOverlay.js';

// Guarded dynamic import (#4918 revert-oracle): a static `import { splitToolEn }
// from '...'` would fail this file's whole LOAD once `check-test-revert-oracle.mjs`
// reverts the production hunks (a brand-new module reverts to a deletion),
// which the oracle reports as INCONCLUSIVE rather than a red assertion. A
// guarded dynamic import turns a missing catalogue into a clean
// `describe.skip` instead.
let splitToolEn: typeof SplitToolEnType | undefined;
try {
  ({ splitToolEn } = await import('@/i18n/catalogues/split-tool.en'));
} catch {
  splitToolEn = undefined;
}
const HAS_CATALOGUE = splitToolEn !== undefined;
const CATALOGUE: typeof SplitToolEnType = splitToolEn ?? ({} as typeof SplitToolEnType);
if (splitToolEn) Object.assign(en, splitToolEn);

type SplitToolKey = keyof typeof CATALOGUE;
const KEYS = Object.keys(CATALOGUE) as SplitToolKey[];

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

/** Key-specific pseudo translation; keeps every `{placeholder}` of the English text. */
const mark = (key: SplitToolKey) => `⟦${key}|${CATALOGUE[key]}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, mark(key)]));

const AIMING_STATE = {
  activeTool: 'split',
  splitMode: 'aiming',
  splitHoverPoint: [1, 0, 0] as [number, number, number],
  splitHoverDistance: 1.5,
  splitHoverLength: 3,
  splitTargetModelId: 'm1',
  splitTargetExpressId: 42,
  cameraCallbacks: {
    projectToScreen: () => ({ x: 10, y: 10 }),
    getViewpoint: () => null,
  },
  clearSplitHover: () => {},
  setSelectedEntityId: () => {},
} as unknown as Partial<ReturnType<typeof useViewerStore.getState>>;

const RESET = {
  activeTool: 'select',
  splitMode: 'idle',
  splitHoverPoint: null,
  splitHoverDistance: null,
  splitHoverLength: null,
} as unknown as Partial<ReturnType<typeof useViewerStore.getState>>;

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(RESET);
});

describe('Split tool localization (#4918)', { skip: !HAS_CATALOGUE && 'split-tool.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  it('translates the numeric-input panel: mode toggle, length readout, Cut and Snap', () => {
    useViewerStore.setState(AIMING_STATE);
    const container = render(<SplitNumericInput />);
    const english = new Set<string>();
    addReadable(container, english);

    // Every static key here must be visible in this render — the "aiming"
    // state with a positive splitHoverLength surfaces the whole panel.
    const STATIC_KEYS: SplitToolKey[] = [
      'splitTool.modeMetres',
      'splitTool.ofLength',
      'splitTool.cutButton',
      'splitTool.snapLabel',
    ];
    for (const key of STATIC_KEYS) {
      // 'splitTool.ofLength' interpolates {length}; check its literal
      // English rendering separately below rather than exact-matching here.
      if (key === 'splitTool.ofLength') continue;
      assert.ok(english.has(CATALOGUE[key]), `expected "${CATALOGUE[key]}" (${key}) to be visible before switching locale`);
    }
    assert.ok([...english].some((s) => s.includes('of 3.00m')), 'expected the interpolated length readout to render');

    registerLocale('split-tool-pseudo', PSEUDO);
    act(() => setLocale('split-tool-pseudo'));
    const after = new Set<string>();
    addReadable(container, after);

    for (const key of STATIC_KEYS) {
      if (key === 'splitTool.ofLength') continue;
      assert.ok(after.has(mark(key)), `${key}: must be translated, marked text not found`);
    }
    // Interpolation: the marked template keeps its {length} placeholder
    // filled with the real value, not the literal token.
    assert.ok(
      [...after].some((s) => s === `⟦splitTool.ofLength|of {length}m⟧`.replace('{length}', '3.00')),
      'expected the interpolated splitTool.ofLength key to render marked with its {length} value substituted',
    );
  });

  it('translates the idle hint chip', () => {
    useViewerStore.setState({
      activeTool: 'split',
      splitMode: 'idle',
      splitHoverPoint: null,
      cameraCallbacks: { projectToScreen: () => null, getViewpoint: () => null },
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
    const container = render(<SplitOverlay />);
    const english = new Set<string>();
    addReadable(container, english);
    assert.ok(english.has(CATALOGUE['splitTool.hintChip']));

    registerLocale('split-overlay-pseudo', PSEUDO);
    act(() => setLocale('split-overlay-pseudo'));
    const after = new Set<string>();
    addReadable(container, after);
    assert.ok(after.has(mark('splitTool.hintChip')), 'splitTool.hintChip: must be translated, marked text not found');
  });
});
