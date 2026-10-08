/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rendered contrast of the Measure / Section / hover secondary text fixed
 * under #4792 (#6205): each site is mounted in the state that shows it and
 * the text is measured, by its visible string, against the surface it is
 * really painted on, in light, dark and colorful.
 *
 * Surfaces:
 * - Measurements panel (list / point / quantities tabs): its markup paints no
 *   background, so it is wrapped in the docked panel host `ViewerLayout`'s
 *   root (`VIEWER_SHELL_SURFACE`).
 * - HUD cards (`MeasureGeoReadout`, `SectionToolbar`): the mounted component
 *   renders its own `HudSurface` (`bg-popover/[.94]`); it is wrapped in the
 *   loaded-model `ViewportContainer` root (`bg-zinc-50 dark:bg-black`), the
 *   nearest painted DOM ancestor of `ViewportHud`. The 3D canvas behind the
 *   card is a sibling, not an ancestor, and shows through only 6%.
 * - `HoverTooltip` paints its own opaque `bg-popover`.
 */

import '@/test/setup-dom.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { resolve } from '@/i18n/registry';
import { useViewerStore, type FederatedModel } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { MeasurementsPanel } from '@/components/viewer/MeasurementsPanel.js';
import { MeasureGeoReadout } from '@/components/viewer/tools/MeasureHudReadouts.js';
import { SectionToolbar } from '@/components/viewer/tools/SectionToolbar.js';
import { HoverTooltip } from '@/components/viewer/HoverTooltip.js';
import { ViewportHud } from '@/components/viewport-ui/hud/ViewportHud.js';
import { cleanup, render, waitFor } from '@/test/render.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { closeContrastBrowser, warmContrastBrowser } from './render-harness.js';
import {
  assertRenderedTextClears,
  assertForcedClassReddens,
  snapshotRenderedDom,
  THEMES,
  VIEWER_SHELL_SURFACE,
} from './rendered-text-contrast.js';
import { WCAG_AA_NORMAL_TEXT } from './wcag.js';

/** `ViewportContainer`'s loaded-model root `<div>`: the painted DOM ancestor of the HUD. */
const VIEWPORT_SURFACE = 'relative bg-zinc-50 dark:bg-black';

const CRS_NAME = 'EPSG:32760';
const OLD_PANEL_CLASS = 'font-mono text-[9px] leading-tight text-muted-foreground/70';
const OLD_TOOLTIP_CLASS = 'text-[11px] text-muted-foreground/80';

const INITIAL = useViewerStore.getInitialState();
afterEach(() => {
  cleanup();
  useViewerStore.setState(INITIAL, true);
});
before(warmContrastBrowser, { timeout: 300_000 });
after(closeContrastBrowser);

const point = (x: number, y: number, z: number) => ({ x, y, z, screenX: x, screenY: y });

/**
 * A two-model federation whose second model alignment re-baked into the first
 * (`rebased`), the first carrying a usable map conversion (via a georef edit,
 * the same path the georef editor uses), Geo XYZ on, and one finished
 * measurement: every Point-tab row, the rebased notice, the CRS line and the
 * list's E/N/H lines render.
 */
function seedGeoreferencedRebased(): void {
  const anchor = { ...fixtureModel('m1'), loadedAt: 1 } as FederatedModel;
  const rebased = { ...fixtureModel('m2'), loadedAt: 2, federationAlignmentStatus: 'same-crs' } as FederatedModel;
  useViewerStore.setState({
    models: new Map([['m1', anchor], ['m2', rebased]]),
    activeModelId: 'm1',
    georefMutations: new Map([['m1', {
      projectedCRS: { name: CRS_NAME },
      mapConversion: { eastings: 729013.35, northings: 9063992.68, orthogonalHeight: 0 },
    }]]),
    geoReadoutEnabled: true,
    activeMeasurement: null,
    measurements: [{ id: 'd', start: point(0, 0, 0), end: point(1, 2, 3), distance: 3.74 }],
    measureReferencePoint: null,
  });
}

/** Mount the docked Measurements panel and open `tabKey`'s tab. */
function mountMeasurementsPanel(tabKey?: Parameters<typeof resolve>[0]): HTMLElement {
  const container = render(<MeasurementsPanel onClose={() => {}} />);
  if (!tabKey) return container;
  const label = resolve(tabKey);
  const tab = [...container.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.trim() === label);
  assert.ok(tab, `no tab labelled "${label}" on the Measurements panel`);
  act(() => {
    tab.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  });
  return container;
}

/** Classification and the picked-point projection settle separately (#7060).
 * Capture the claimed georeferenced state only after both rows are mounted. */
async function waitForProjectedPointReadout(panel: HTMLElement): Promise<void> {
  await waitFor(() => (panel.textContent?.includes(CRS_NAME) ?? false)
    && (panel.textContent?.includes(resolve('measure.point.rowLatLon')) ?? false),
  'the projected Point readout must resolve before its contrast snapshot');
}

/** Qty tab state from `measure-quantities-mesh-area.test.tsx`: a selected
 *  element with mesh geometry but no data store, so the mesh-area row, the
 *  net/gross legend and the unresolved-element footnote all render. */
function seedQuantities(): void {
  useViewerStore.setState({
    selectedEntitiesSet: new Set(['m1:42']),
    models: new Map([['m1', {
      id: 'm1', name: 'model', ifcDataStore: null, visible: true, idOffset: 0, maxExpressId: 100000, loadedAt: 1,
      geometryResult: { meshes: [{ expressId: 42, positions: [0, 0, 0, 3, 0, 0, 0, 4, 0], indices: [0, 1, 2] }] },
    } as unknown as FederatedModel]]),
  });
}

function mountHoverTooltip(): string {
  useViewerStore.setState({
    models: new Map([['m', fixtureModel('m', { entities: [{ expressId: 42, type: 'IfcWall', name: 'Wall A' }] })]]),
    activeModelId: 'm',
    hoverTooltipsEnabled: true,
    hoverState: { entityId: 42, screenX: 10, screenY: 10, worldXYZ: { x: 1, y: 2, z: 3 } },
  });
  render(<HoverTooltip />);
  return '1.00, 2.00, 3.00';
}

function mountSectionToolbar(): void {
  useViewerStore.setState({
    activeTool: 'section',
    sectionPlane: getDefaultSectionPlane(),
    sectionPickMode: false,
    models: new Map([['m', fixtureModel('m')]]),
    activeModelId: 'm',
  });
  render(<SectionToolbar />);
}

const rebasedNote = () => resolve('measure.point.rebasedNote', { name: resolve('measure.point.anchorModelFallback') });

describe('Measure / Section / hover secondary text: rendered contrast (#4792, #6205)', () => {
  for (const theme of THEMES) {
    it(`MeasurePointReadout base state (Model row label, "m" unit hint) clears AA in ${theme}`, async () => {
      useViewerStore.setState({
        activeMeasurement: null,
        measurements: [{ id: 'p', start: point(0, 0, 0), end: point(1, 2, 3), distance: 3.74 }],
        geoReadoutEnabled: false,
      });
      mountMeasurementsPanel('measure.section.point.label');
      await assertRenderedTextClears(theme, snapshotRenderedDom(VIEWER_SHELL_SURFACE),
        [resolve('measure.point.rowModel'), 'm'], WCAG_AA_NORMAL_TEXT);
    });

    it(`MeasurePointReadout rebased + georeferenced rows, notice and CRS clear AA in ${theme}`, async () => {
      seedGeoreferencedRebased();
      const panel = mountMeasurementsPanel('measure.section.point.label');
      await waitForProjectedPointReadout(panel);
      await assertRenderedTextClears(theme, snapshotRenderedDom(VIEWER_SHELL_SURFACE), [
        resolve('measure.point.rowAnchor'),
        resolve('measure.point.rowMap'),
        'm',
        rebasedNote(),
        CRS_NAME,
      ], WCAG_AA_NORMAL_TEXT);
    });

    it(`MeasurementList geo-readout EnhLine labels clear AA in ${theme}`, async () => {
      seedGeoreferencedRebased();
      const panel = mountMeasurementsPanel();
      await waitFor(() => ['A', 'B'].every(label => [...panel.querySelectorAll('span')]
        .some(element => element.textContent?.trim() === label)),
      'the projected endpoint E/N/H rows must mount before their contrast snapshot');
      await assertRenderedTextClears(theme, snapshotRenderedDom(VIEWER_SHELL_SURFACE), ['A', 'B'], WCAG_AA_NORMAL_TEXT);
    });

    it(`MeasureQuantities row label and net/gross/mesh footnote clear AA in ${theme}`, async () => {
      seedQuantities();
      mountMeasurementsPanel('measure.section.quantities.label');
      await assertRenderedTextClears(theme, snapshotRenderedDom(VIEWER_SHELL_SURFACE), [
        resolve('measure.quantities.areaMeshLabel'),
        resolve('measure.quantities.legend'),
      ], WCAG_AA_NORMAL_TEXT);
    });

    it(`MeasureGeoReadout projected-CRS name on its HudSurface clears AA in ${theme}`, async () => {
      seedGeoreferencedRebased();
      const hud = render(<><ViewportHud /><MeasureGeoReadout /></>);
      await waitFor(() => (hud.textContent?.includes(CRS_NAME) ?? false)
        && /-?\d+\.\d{6}/.test(hud.textContent ?? ''),
        'the projected HUD readout must resolve before its contrast snapshot');
      await assertRenderedTextClears(theme, snapshotRenderedDom(VIEWPORT_SURFACE), [CRS_NAME], WCAG_AA_NORMAL_TEXT);
    });

    it(`HoverTooltip world-coordinate readout clears AA in ${theme}`, async () => {
      const xyz = mountHoverTooltip();
      await assertRenderedTextClears(theme, snapshotRenderedDom(VIEWPORT_SURFACE), [xyz], WCAG_AA_NORMAL_TEXT);
    });

    it(`SectionToolbar heading caption on its HudSurface clears AA in ${theme}`, async () => {
      mountSectionToolbar();
      await assertRenderedTextClears(theme, snapshotRenderedDom(VIEWPORT_SURFACE),
        [resolve('sectionTool.heading')], WCAG_AA_NORMAL_TEXT);
    });

    it(`non-vacuousness: ${OLD_PANEL_CLASS} on MeasurePointReadout rebased notice reddens in ${theme}`, async (t) => {
      seedGeoreferencedRebased();
      const panel = mountMeasurementsPanel('measure.section.point.label');
      await waitForProjectedPointReadout(panel);
      const ratios = await assertForcedClassReddens(theme, rebasedNote(), OLD_PANEL_CLASS, WCAG_AA_NORMAL_TEXT, VIEWER_SHELL_SURFACE);
      t.diagnostic(ratios.map((r) => `${r.toFixed(2)}:1`).join(', '));
    });

    it(`non-vacuousness: ${OLD_TOOLTIP_CLASS} on HoverTooltip world-coordinate readout reddens in ${theme}`, async (t) => {
      const xyz = mountHoverTooltip();
      const ratios = await assertForcedClassReddens(theme, xyz, OLD_TOOLTIP_CLASS, WCAG_AA_NORMAL_TEXT, VIEWPORT_SURFACE);
      t.diagnostic(ratios.map((r) => `${r.toFixed(2)}:1`).join(', '));
    });
  }
});
