/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Split tool's HUD presence (#4918, on the `TOOL_HUD` registry since
 * #5503) reads the i18n catalogue.
 *
 * The oracle is a pseudo-locale that maps every `splitTool.*` key to a
 * marked copy of its English text. Three surfaces: the bar (`SplitBar`),
 * the registry hint the HUD places bottom-center (mounted through the real
 * `ToolOverlays` + `ViewportHud`), and the cursor-anchored distance entry
 * (`SplitCursorInput`, rendered in its single-click-element "aiming"
 * state inside the scene harness). The locale is switched live and every
 * marked string that was readable in English must reappear marked.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { splitToolEn as SplitToolEnType } from '@/i18n/catalogues/split-tool.en';
import { useViewerStore } from '@/store';
import { renderScene } from '../../viewport-ui/scene/test/scene-test-support.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';
import { SplitBar, SplitScene } from './SplitHud.js';

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

type SplitToolKey = keyof typeof CATALOGUE;
const KEYS = Object.keys(CATALOGUE) as SplitToolKey[];

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) out.add(placeholder);
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

function assertTranslates(root: ParentNode, keys: SplitToolKey[], localeName: string): void {
  const english = new Set<string>();
  addReadable(root, english);
  for (const key of keys) {
    assert.ok(english.has(CATALOGUE[key]), `expected "${CATALOGUE[key]}" (${key}) to be visible before switching locale`);
  }
  registerLocale(localeName, PSEUDO);
  act(() => setLocale(localeName));
  const after = new Set<string>();
  addReadable(root, after);
  for (const key of keys) {
    assert.ok(after.has(mark(key)), `${key}: must be translated, marked text not found`);
  }
}

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
  it('translates the bar: tool name and close', () => {
    const ui = render(<SplitBar />);
    assertTranslates(ui, ['splitTool.barLabel', 'splitTool.closeAria'], 'split-bar-pseudo');
  });

  it('translates the cursor distance entry: accessible name and unit', () => {
    useViewerStore.setState(AIMING_STATE);
    const scene = renderScene(<SplitScene />);
    scene.flush();
    assertTranslates(scene.container, ['splitTool.cutDistanceAria', 'splitTool.unitMetres'], 'split-input-pseudo');
  });

  it('translates the registry hint the HUD places bottom-center', () => {
    useViewerStore.setState({
      ...RESET,
      activeTool: 'split',
      cameraCallbacks: { projectToScreen: () => null, getViewpoint: () => null },
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
    render(<ViewportHud />);
    render(<SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot>);
    const region = document.querySelector('[data-hud-region="bottom-center"]');
    assert.ok(region, 'the HUD bottom-center region exists');
    assertTranslates(region, ['splitTool.hint'], 'split-hint-pseudo');
  });
});
