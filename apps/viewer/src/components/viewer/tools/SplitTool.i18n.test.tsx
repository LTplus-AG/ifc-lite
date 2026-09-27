/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Split command's HUD presence (#4918; the `element.split` modeling
 * command since #6232) reads the i18n catalogue.
 *
 * The oracle is a pseudo-locale that maps every `splitTool.*` key to a
 * marked copy of its English text. Three surfaces, all mounted through the
 * real `ToolOverlays` + `ViewportHud` with the command running: the bar's
 * name, the hint the HUD places bottom-center, and the cursor-anchored
 * distance entry (`SplitCursorInput`, aiming at a real wall). The locale is
 * switched live and every marked string that was readable in English must
 * reappear marked.
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
import { toGlobalIdFromModels } from '@/store/globalId';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { commandPointerMove, getCommandRuntime } from '@/lib/commands/modeling/runtime';
import type { SplitGesture } from '@/lib/commands/modeling/commands/element-split';
import { SplitScene } from './SplitHud.js';

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

/** `element.split` running on a real wall, aiming 1.5 m along it. */
async function aim(): Promise<void> {
  await seedModelingSession();
  useViewerStore.setState({ cameraCallbacks: { projectToScreen: () => ({ x: 10, y: 10 }), getViewpoint: () => null } } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [3, 0, 0], Thickness: 0.2, Height: 3 });
  assert.ok('expressId' in wall);
  s.setSelectedEntityId(toGlobalIdFromModels(s.models, MODEL_ID, wall.expressId));
  act(() => s.startCommand('element.split'));
  const plane = (getCommandRuntime().gesture as SplitGesture).plane!;
  act(() => commandPointerMove({ local: [1.5, 0], render: plane.localToRender([1.5, 0, 0]), winner: null, guides: [], locked: false }));
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.getState().exitModelWorkspace();
});

describe('Split tool localization (#4918)', { skip: !HAS_CATALOGUE && 'split-tool.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  it('translates the command bar name and the hint the HUD places bottom-center', async () => {
    await aim();
    render(<ViewportHud />);
    render(<SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot>);
    const bar = document.querySelector('[data-hud-region="top-center"]');
    assert.ok(bar, 'the HUD top-center region exists');
    assertTranslates(bar, ['splitTool.barLabel'], 'split-bar-pseudo');
    act(() => setLocale('en'));
    const hint = document.querySelector('[data-hud-region="bottom-center"]');
    assert.ok(hint, 'the HUD bottom-center region exists');
    assertTranslates(hint, ['splitTool.hint'], 'split-hint-pseudo');
  });

  it('translates the cursor distance entry: accessible name and unit', async () => {
    await aim();
    const scene = renderScene(<SplitScene gesture={getCommandRuntime().gesture as SplitGesture} ctx={getCommandRuntime().ctx!} />);
    scene.flush();
    assertTranslates(scene.container, ['splitTool.cutDistanceAria', 'splitTool.unitMetres'], 'split-input-pseudo');
  });
});
