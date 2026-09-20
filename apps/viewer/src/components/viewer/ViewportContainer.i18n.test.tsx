/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ViewportContainer.tsx`'s own chrome for the #4918 viewport/lighting
 * slice's `viewport-lighting.en.ts` catalogue: the no-model welcome/empty
 * state (title, tagline, action buttons, the demo-stack promo, and the
 * footer chips) and — once `useWebGPU` settles without a `navigator.gpu`
 * in this DOM environment — the WebGPU-unavailable banner. The loaded-model
 * "Add Model to Scene" drop overlay needs a live `dragenter` sequence and a
 * populated `models` map to mount and is left to manual verification, same
 * reasoning `HierarchyPanel.i18n.test.tsx` gives for chrome that needs a
 * loaded model.
 *
 * Same pseudo-locale-oracle shape as `HierarchyPanel.i18n.test.tsx`: render
 * once in English, register a pseudo-locale that marks every
 * `viewportLighting.container.*` string, switch live, and require every
 * marked string that was readable in English to reappear marked.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { advance, cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { viewportLightingEn as ViewportLightingEnType } from '@/i18n/catalogues/viewport-lighting.en';
import { useViewerStore } from '@/store';
import { ViewportContainer } from './ViewportContainer.js';

// Dynamic + try/catch (not a static import): a revert of this slice's
// production change deletes viewport-lighting.en.ts entirely, and a static
// import would fail the whole test FILE to load (ERR_MODULE_NOT_FOUND)
// rather than let the assertions below fail on their own merits — see
// WebGpuTroubleshooting.i18n.test.tsx for the same pattern.
let viewportLightingEnLoaded: typeof ViewportLightingEnType | undefined;
try {
  ({ viewportLightingEn: viewportLightingEnLoaded } = await import(
    '@/i18n/catalogues/viewport-lighting.en'
  ));
} catch {
  viewportLightingEnLoaded = undefined;
}
const viewportLightingEn = viewportLightingEnLoaded ?? ({} as typeof ViewportLightingEnType);

type Key = keyof typeof viewportLightingEn;

function markValue(key: string, value: TranslationValue | undefined): TranslationValue {
  if (typeof value !== 'string') return `⟦${key}|MISSING⟧`;
  return `⟦${key}|${value}⟧`;
}
const CONTAINER_KEYS = (Object.keys(viewportLightingEn) as Key[]).filter((key) =>
  key.startsWith('viewportLighting.container.'),
);
const PSEUDO: Catalogue = Object.fromEntries(CONTAINER_KEYS.map((key) => [key, markValue(key, viewportLightingEn[key])]));
const PSEUDO_LOCALE = 'viewport-container-pseudo';

/** Collects each element's OWN text (not the concatenated subtree), so a
 *  short value like "New" cannot false-positive-match as a substring of an
 *  unrelated node's text ("New here?") the way a whole-body substring
 *  search would — same helper shape as `HierarchyPanel.i18n.test.tsx`'s
 *  `readable()`. */
function readable(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  container.querySelectorAll('*').forEach((element) => {
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState({
    ifcDataStore: null,
    geometryResult: null,
    models: new Map(),
  });
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('ViewportContainer localization (#4918 viewport/lighting slice)', () => {
  it('translates the no-model welcome state, its own chrome, and the WebGPU banner', async () => {
    const container = render(<ViewportContainer />);
    // Let `useWebGPU`'s async `requestAdapter()` probe settle (no
    // `navigator.gpu` in this DOM environment, so it resolves unsupported).
    await advance(0);
    const english = readable(container);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readable(container);
    act(() => setLocale('en'));

    let verified = 0;
    for (const key of CONTAINER_KEYS) {
      const value = viewportLightingEn[key];
      if (typeof value !== 'string') continue; // no plural key in this namespace
      if (!english.has(value)) continue; // needs a loaded model or a live drag — not mounted here
      assert.ok(after.has(`⟦${key}|${value}⟧`), `${key}: "${value}" must be translated, marked text not found`);
      verified += 1;
    }
    // Guards against the loop above silently verifying nothing if the
    // empty-state branch ever stops mounting.
    assert.ok(verified >= 15, `expected at least 15 empty-state keys to render as their own text node, saw ${verified}`);

    // A representative set that MUST have rendered in the no-model empty
    // state, so a regression that stops mounting this branch fails loudly
    // instead of the loop above silently skipping everything.
    const mustRender: Key[] = [
      'viewportLighting.container.emptyState.title',
      'viewportLighting.container.emptyState.tagline',
      'viewportLighting.container.emptyState.startBlank',
      'viewportLighting.container.emptyState.openFromCloud',
      'viewportLighting.container.emptyState.driveWithLlm',
      'viewportLighting.container.emptyState.footerCaption',
      'viewportLighting.container.emptyState.layersPromo.title',
      'viewportLighting.container.emptyState.footer.discoverPrompt',
      'viewportLighting.container.emptyState.footer.shortcutsLabel',
    ];
    for (const key of mustRender) {
      const value = viewportLightingEn[key] as string;
      assert.ok(english.has(value), `${key}: "${value}" expected visible in English before switching locale`);
      assert.ok(after.has(`⟦${key}|${value}⟧`), `${key}: must be translated, marked text not found`);
    }
  });
});
