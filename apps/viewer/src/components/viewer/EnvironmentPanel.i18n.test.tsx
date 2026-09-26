/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `EnvironmentPanel.tsx` (#5506: the docked side panel that replaced the
 * floating "Sun & Sky" panel, `SunSkyPanel.tsx`) and its two sub-panels,
 * `ShadowControls.tsx` and `SunTimeControls.tsx` (both rendered inline by
 * `EnvironmentPanel` in standalone/WebGPU mode — #4918 viewport/lighting
 * slice's `viewport-lighting.en.ts` catalogue). Covers the header, the
 * standalone environment picker (including the `CONTEXT_SOURCES`/
 * `SWEEP_MODES` `labelKey` tables' rendered option text), the shadow and
 * manual time-of-day sub-panels, and — once `cesiumAvailable`/`solarEnabled`
 * are set on the store — the sun-study controls and its readout grid. The
 * world-context (Cesium-enabled) base-map picker needs `cesiumEnabled` on
 * the store and is left to manual verification, same reasoning
 * `HierarchyPanel.i18n.test.tsx` gives for chrome that needs a loaded
 * model.
 *
 * Same pseudo-locale-oracle shape as `HierarchyPanel.i18n.test.tsx`.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import type { viewportLightingEn as ViewportLightingEnType } from '@/i18n/catalogues/viewport-lighting.en';
import { useViewerStore } from '@/store';
import { EnvironmentPanel } from './EnvironmentPanel.js';

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
const PANEL_KEYS = (Object.keys(viewportLightingEn) as Key[]).filter(
  (key) =>
    key.startsWith('viewportLighting.sunSkyPanel.') ||
    key.startsWith('viewportLighting.shadowControls.') ||
    key.startsWith('viewportLighting.sunTimeControls.'),
);
const PSEUDO: Catalogue = Object.fromEntries(PANEL_KEYS.map((key) => [key, markValue(key, viewportLightingEn[key])]));
const PSEUDO_LOCALE = 'environment-panel-pseudo';

/** Collects each element's OWN text (not the concatenated subtree), so a
 *  short value like "Sky" cannot false-positive-match as a substring of an
 *  unrelated node's text ("Sun & Sky") the way a whole-body substring search
 *  would — same helper shape as `HierarchyPanel.i18n.test.tsx`'s `readable()`. */
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
    cesiumEnabled: false,
    cesiumAvailable: true,
    solarEnabled: true,
    envShadowsEnabled: true,
    envSunTimeEnabled: true,
  });
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({
    cesiumAvailable: false,
    solarEnabled: false,
    envShadowsEnabled: false,
    envSunTimeEnabled: false,
  });
});

describe('EnvironmentPanel localization (#4918 viewport/lighting slice, #5506 side panel)', () => {
  it('translates the header, standalone environment/shadow/time-of-day controls, and the sun study', () => {
    const container = render(<EnvironmentPanel />);
    const english = readable(container);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = readable(container);
    act(() => setLocale('en'));

    let verified = 0;
    for (const key of PANEL_KEYS) {
      const value = viewportLightingEn[key];
      if (typeof value !== 'string') continue;
      if (!english.has(value)) continue; // needs the Cesium world-context branch, or is an aria-label/title — not checked as own text here
      assert.ok(after.has(`⟦${key}|${value}⟧`), `${key}: "${value}" must be translated, marked text not found`);
      verified += 1;
    }
    assert.ok(verified >= 12, `expected at least 12 standalone-mode keys to render as their own text node, saw ${verified}`);

    // A representative set spanning all three files this suite mounts, so a
    // regression that stops mounting one of the sub-panels fails loudly.
    const mustRender: Key[] = [
      'viewportLighting.sunSkyPanel.header.title',
      'viewportLighting.sunSkyPanel.standalone.environmentLabel',
      'viewportLighting.sunSkyPanel.sunStudy.title',
      'viewportLighting.sunSkyPanel.sunStudy.on',
      'viewportLighting.sunSkyPanel.sunStudy.dateLabel',
      'viewportLighting.sunSkyPanel.sunStudy.readout.azimuth',
      'viewportLighting.shadowControls.title',
      'viewportLighting.shadowControls.softnessLabel',
      'viewportLighting.sunTimeControls.title',
      'viewportLighting.sunTimeControls.sunTimeLabel',
    ];
    for (const key of mustRender) {
      const value = viewportLightingEn[key] as string;
      assert.ok(english.has(value), `${key}: "${value}" expected visible in English before switching locale`);
      assert.ok(after.has(`⟦${key}|${value}⟧`), `${key}: must be translated, marked text not found`);
    }
  });

  it('translates the sweep-mode select options via their labelKey/hintKey table', () => {
    const container = render(<EnvironmentPanel />);
    const options = Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '');
    assert.ok(options.includes(viewportLightingEn['viewportLighting.sunSkyPanel.sunStudy.sweepModes.day.label'] as string));
    assert.ok(options.includes(viewportLightingEn['viewportLighting.sunSkyPanel.sunStudy.sweepModes.year.label'] as string));
  });

  it('renders a close button that calls onClose (#5506: the panel is docked, not floating — the host supplies onClose)', () => {
    let closed = false;
    const container = render(<EnvironmentPanel onClose={() => { closed = true; }} />);
    const closeButton = container.querySelector('button[aria-label="Close Environment panel"]');
    assert.ok(closeButton, 'expected a close button wired to the registry title');
    act(() => { (closeButton as HTMLButtonElement).click(); });
    assert.strictEqual(closed, true, 'onClose must fire — mutating the click handler away must fail this test');
  });
});
