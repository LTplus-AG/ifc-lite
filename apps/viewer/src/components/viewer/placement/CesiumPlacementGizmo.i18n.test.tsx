/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `CesiumPlacementGizmo`'s SVG drag handles read the i18n catalogue (#4918
 * slice: cesiumgeo, `cesium-geo.en.ts`): the plane/height drag tooltip
 * titles and their button aria-labels. The docked `placement` panel's
 * Georeference tab chrome (deltas, nudge/rotate, apply/reset) is covered
 * separately, in `GeoreferenceTab.i18n.test.tsx` (#5505).
 *
 * #5995: the gizmo used to run its own `requestAnimationFrame` loop, which
 * forced this file to stub it globally so mounting settled synchronously.
 * It now computes its projection directly in the render body (woken by the
 * scene kernel's shared `SceneProjector` via `useProjectorTick`, following
 * #5510), so a single synchronous `render()` already reflects the final
 * projected geometry and no rAF stub is needed.
 */
import '@/test/setup-dom.js';
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { en } from '@/i18n/en';
import type { TranslationParameters, TranslationValue, PluralTranslation } from '@/i18n';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';
import { CesiumPlacementGizmo } from './CesiumPlacementGizmo.js';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('cesiumGeo.placement.drag')),
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
const PSEUDO_LOCALE = 'cesium-placement-gizmo-pseudo';

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
    assert.ok(englishDom.has(english), `${occ.key}: expected English text ${JSON.stringify(english)} to be on screen before the locale switch`);
  }
  act(() => setLocale(PSEUDO_LOCALE));
  try {
    for (const occ of occurrences) {
      const pseudo = resolve(occ.key as never, occ.params).trim();
      assert.ok(afterDom.has(pseudo), `${occ.key}: "${pseudo}" must be translated, marked text not found in the switched-locale DOM`);
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

const projectedCRS: ProjectedCRS = { id: 2, name: 'EPSG:2056', mapUnitScale: 1 };
const mapConversion: MapConversion = {
  id: 1, sourceCRS: 0, targetCRS: 0,
  eastings: 100, northings: 200, orthogonalHeight: 10,
  xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1, factorZ: 1,
};

const originalState = useViewerStore.getState();

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState({
    cesiumPlacementEditMode: true,
    cesiumPlacementDraftModelId: 'm0',
    cesiumPlacementDraft: null,
  });
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
  setGlobalRendererRef({ current: null });
  useViewerStore.setState(originalState, true);
});

describe('CesiumPlacementGizmo localization (#4918, #5505)', () => {
  it('translates the drag-gizmo tooltip titles and handle aria-labels', () => {
    const canvas = {
      width: 100, height: 100, clientWidth: 100, clientHeight: 100,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    };
    const camera = {
      projectToScreen: (p: { x: number; y: number; z: number }) => ({ x: 50 + p.x, y: 50 - p.y }),
      unprojectToRay: () => ({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: -1, z: 0 } }),
    };
    setGlobalRendererRef({ current: { getCamera: () => camera, getCanvas: () => canvas } as never });
    const container = render(
      <CesiumPlacementGizmo
        modelId="m0"
        mapConversion={mapConversion}
        baseMapConversion={mapConversion}
        projectedCRS={projectedCRS}
        coordinateInfo={{
          originShift: { x: 0, y: 0, z: 0 },
          originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } },
          shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } },
          hasLargeCoordinates: false,
        }}
        lengthUnitScale={1}
      />,
    );
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'cesiumGeo.placement.dragPlaneAriaLabel' },
        { key: 'cesiumGeo.placement.dragHeightAriaLabel' },
        { key: 'cesiumGeo.placement.dragPlaneTitle' },
        { key: 'cesiumGeo.placement.dragHeightTitle' },
        { key: 'cesiumGeo.placement.dragXYLabel' },
      ],
      englishDom,
      afterDom,
    );
  });
});
