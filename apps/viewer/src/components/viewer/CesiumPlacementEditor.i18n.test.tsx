/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `CesiumPlacementEditor`'s own chrome reads the i18n catalogue (#4918
 * slice: cesiumgeo, `cesium-geo.en.ts`): the floating panel's header,
 * delta readouts, nudge/height/rotate controls, and apply/reset actions,
 * plus the SVG drag-gizmo's tooltip titles and aria-labels. `Eastings`,
 * `Northings`, and `OrthogonalHeight` are exact `IfcMapConversion` EXPRESS
 * attribute names used as bare field labels and are asserted separately —
 * they must stay literal through the locale switch, the same house rule
 * `GeoreferencingPanel.tsx`'s `GeorefRow` labels already follow.
 */
import '@/test/setup-dom.js';
import { describe, it, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { cleanup, click, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { en } from '@/i18n/en';
import type { TranslationParameters, TranslationValue, PluralTranslation } from '@/i18n';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';
import { CesiumPlacementEditor } from './CesiumPlacementEditor.js';

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => key.startsWith('cesiumGeo.placement.')),
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
const PSEUDO_LOCALE = 'cesium-placement-pseudo';

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

const projectedCRS: ProjectedCRS = { id: 2, name: 'EPSG:2056', mapUnitScale: 1 };
const mapConversion: MapConversion = {
  id: 1, sourceCRS: 0, targetCRS: 0,
  eastings: 100, northings: 200, orthogonalHeight: 10,
  xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1, factorZ: 1,
};

// The gizmo re-projects every animation frame via a self-scheduling
// `requestAnimationFrame` loop that keeps running for as long as `editMode`
// is true — same reasoning `CesiumPlacementEditor.heightScale.test.tsx`
// documents for stubbing it module-wide rather than per test.
const originalRaf = globalThis.requestAnimationFrame;
before(() => { globalThis.requestAnimationFrame = () => 0; });
after(() => { globalThis.requestAnimationFrame = originalRaf; });

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

describe('CesiumPlacementEditor localization (#4918)', () => {
  it('translates the panel header, badges, and delta readouts', () => {
    const container = render(
      <CesiumPlacementEditor
        modelId="m0"
        mapConversion={mapConversion}
        baseMapConversion={mapConversion}
        projectedCRS={projectedCRS}
        lengthUnitScale={1}
      />,
    );
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'cesiumGeo.placement.headerAriaLabel' },
        { key: 'cesiumGeo.placement.headerTitle' },
        { key: 'cesiumGeo.placement.collapsePanel' },
        { key: 'cesiumGeo.placement.closeAriaLabel' },
        { key: 'cesiumGeo.placement.deltaELabel' },
        { key: 'cesiumGeo.placement.deltaNLabel' },
        { key: 'cesiumGeo.placement.deltaZLabel' },
        { key: 'cesiumGeo.placement.deltaRLabel' },
        { key: 'cesiumGeo.placement.xAxisAngleLabel' },
        { key: 'cesiumGeo.placement.dragHint' },
      ],
      englishDom,
      afterDom,
    );
    // Exact IfcMapConversion EXPRESS attribute names stay literal, the same
    // house rule GeoreferencingPanel.tsx's GeorefRow labels follow.
    for (const name of ['Eastings', 'Northings', 'OrthogonalHeight']) {
      assert.ok(englishDom.has(name), `${name} must render as-is`);
      assert.ok(afterDom.has(name), `${name} must not be marked by the pseudo-locale`);
    }
  });

  it('translates the nudge, height, and rotate control clusters', () => {
    const container = render(
      <CesiumPlacementEditor
        modelId="m0"
        mapConversion={mapConversion}
        baseMapConversion={mapConversion}
        projectedCRS={projectedCRS}
        lengthUnitScale={1}
      />,
    );
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'cesiumGeo.placement.nudgeOneMeter' },
        { key: 'cesiumGeo.placement.nudgeNorthAriaLabel' },
        { key: 'cesiumGeo.placement.nudgeNorthLabel' },
        { key: 'cesiumGeo.placement.nudgeWestAriaLabel' },
        { key: 'cesiumGeo.placement.nudgeWestLabel' },
        { key: 'cesiumGeo.placement.nudgeEastAriaLabel' },
        { key: 'cesiumGeo.placement.nudgeEastLabel' },
        { key: 'cesiumGeo.placement.nudgeSouthAriaLabel' },
        { key: 'cesiumGeo.placement.nudgeSouthLabel' },
        { key: 'cesiumGeo.placement.heightLabel' },
        { key: 'cesiumGeo.placement.nudgeHeightDownAriaLabel' },
        { key: 'cesiumGeo.placement.nudgeHeightDownLabel' },
        { key: 'cesiumGeo.placement.nudgeHeightUpAriaLabel' },
        { key: 'cesiumGeo.placement.nudgeHeightUpLabel' },
        { key: 'cesiumGeo.placement.rotateLabel' },
        { key: 'cesiumGeo.placement.rotateNegAriaLabel' },
        { key: 'cesiumGeo.placement.rotateNegLabel' },
        { key: 'cesiumGeo.placement.rotatePosAriaLabel' },
        { key: 'cesiumGeo.placement.rotatePosLabel' },
        { key: 'cesiumGeo.placement.applyButton' },
        { key: 'cesiumGeo.placement.resetButton' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates the collapse toggle aria-label after collapsing the panel', () => {
    const container = render(
      <CesiumPlacementEditor
        modelId="m0"
        mapConversion={mapConversion}
        baseMapConversion={mapConversion}
        projectedCRS={projectedCRS}
        lengthUnitScale={1}
      />,
    );
    const collapseButton = container.querySelector(
      `[aria-label="${resolve('cesiumGeo.placement.collapsePanel' as never)}"]`,
    );
    assert.ok(collapseButton, 'the collapse toggle renders expanded by default');
    click(collapseButton!);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate([{ key: 'cesiumGeo.placement.expandPanel' }], englishDom, afterDom);
  });

  it('translates the drag-gizmo tooltip titles and handle aria-labels', () => {
    const canvas = {
      width: 100, height: 100, clientWidth: 100, clientHeight: 100,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    };
    const camera = {
      projectToScreen: (p: { x: number; y: number; z: number }) => ({ x: 50 + p.x, y: 50 - p.y }),
      unprojectToRay: () => ({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: -1, z: 0 } }),
    };
    setGlobalRendererRef({
      current: { getCamera: () => camera, getCanvas: () => canvas } as never,
    });
    const container = render(
      <CesiumPlacementEditor
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
