/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tour, ribbon, and miscellaneous panel secondary text clears WCAG AA as
 * rendered (#6205, rows of #4792's panel table). Each site is mounted in the
 * state where its text shows (TourStepCard with a gated, redocked step; the
 * Info dialog's Learn tab; ClashPanel with a result; a chunk-load failure;
 * RoomPanel and LayersPanel empty states; CustomizeSidebar with a hidden
 * panel; RibbonToolbar's File tab; the Visibility dropdown), located by the
 * text it paints, and measured against the backgrounds its ancestors paint.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Clash, ClashResult } from '@ifc-lite/clash';
import { resolve } from '@/i18n/registry';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { getTour, TOUR_REGISTRY } from '@/lib/tours/registry';
import { useTourStore } from '@/lib/tours/tour-store';
import { TourStepCard } from '@/components/tours/TourStepCard.js';
import { KeyboardShortcutsDialog } from '@/components/viewer/KeyboardShortcutsDialog.js';
import { ClashPanel } from '@/components/viewer/ClashPanel.js';
import { ChunkErrorBoundary } from '@/components/ChunkErrorBoundary.js';
import { RoomPanel } from '@/components/viewer/RoomPanel.js';
import { CustomizeSidebar } from '@/components/viewer/sidebar/CustomizeSidebar.js';
import { RibbonToolbar } from '@/components/viewer/ribbon/RibbonToolbar.js';
import { LayersPanel } from '@/components/viewer/layers/LayersPanel.js';
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ClassVisibilityMenuContent } from '@/components/viewer/toolbar/ClassVisibilityMenu.js';
import { closeContrastBrowser, warmContrastBrowser } from './render-harness.js';
import {
  assertRenderedTextClears,
  assertForcedClassReddens,
  snapshotRenderedDom,
  THEMES,
  VIEWER_SHELL_SURFACE,
} from './rendered-text-contrast.js';
import { WCAG_AA_NORMAL_TEXT } from './wcag.js';

installLayout();

let initialViewer: ReturnType<typeof useViewerStore.getState>;
let initialTour: ReturnType<typeof useTourStore.getState>;

before(() => {
  initialViewer = useViewerStore.getState();
  initialTour = useTourStore.getState();
});
afterEach(() => {
  cleanup();
  useViewerStore.setState(initialViewer, true);
  useTourStore.setState(initialTour, true);
});
before(warmContrastBrowser, { timeout: 300_000 });
after(closeContrastBrowser);

// ── TourStepCard ─────────────────────────────────────────────────────────
// The card paints its own opaque `bg-popover` (solid in every theme); its
// host, TourHost's portaled `fixed inset-0` layer, paints nothing.

const WELCOME = (() => {
  const tour = getTour('welcome');
  assert.ok(tour, 'welcome tour is registered');
  return tour;
})();
/** A gated canvas step: with the hint shown and the gate intact, the "Stuck?"
 *  hint renders; `redockedPanel` adds the docked-back notice. */
const ORBIT_INDEX = WELCOME.steps.findIndex((s) => s.id === 'orbit');
const STEP_COUNT = `${ORBIT_INDEX + 1} / ${WELCOME.steps.length}`;

function mountTourCard(): string {
  assert.ok(WELCOME.steps[ORBIT_INDEX]?.gate, 'orbit step is gated');
  useTourStore.setState({ hintVisible: true, gateBroken: false, redockedPanel: true });
  render(<TourStepCard tour={WELCOME} step={WELCOME.steps[ORBIT_INDEX]} stepIndex={ORBIT_INDEX} targetEl={null} />);
  return snapshotRenderedDom();
}

// ── LearnTab ─────────────────────────────────────────────────────────────
// Mounted inside its only host, KeyboardShortcutsDialog (Radix portal onto
// body), whose DialogContent paints `bg-card`.

const LEARN_MINUTES = TOUR_REGISTRY.map((tour) => resolve('tours.learnTab.minutes', { count: tour.minutes }));

function mountLearnTab(): string {
  render(<KeyboardShortcutsDialog open onClose={() => {}} initialTab="learn" />);
  return snapshotRenderedDom();
}

// ── ClashPanel ───────────────────────────────────────────────────────────
// AnalysisPanel paints `bg-background`; the panel is docked in the viewer
// shell ({@link VIEWER_SHELL_SURFACE}, ViewerLayout.tsx).

function makeResult(): ClashResult {
  const clash = {
    id: 'c1',
    rule: 'all-clashes',
    status: 'hard',
    distance: -0.05,
    distanceKind: 'mesh',
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity: 'critical',
    a: { key: 'g1', ref: 1, model: 'm1', tag: 'IfcWall', name: 'Wall A' },
    b: { key: 'g2', ref: 2, model: 'm1', tag: 'IfcDuctSegment', name: 'Duct B' },
  } as Clash;
  return {
    clashes: [clash],
    summary: {
      total: 1,
      byRule: { 'all-clashes': 1 },
      byTypePair: { 'IfcDuctSegment vs IfcWall': 1 },
      bySeverity: { critical: 1, major: 0, minor: 0, info: 0 },
    },
    rulesRun: [{ id: 'all-clashes', name: 'All clashes', a: '*', mode: 'hard' }],
    ruleCoverage: [{ rule: 'all-clashes', matchedA: 1, matchedB: 1 }],
    settings: { tolerance: 0.005, excludeVoidsAndHosts: true },
  };
}

/** With a result the detection controls collapse to "Detection <mode>";
 *  `clearance` is the mode text (unique on screen, unlike "hard"). */
const CLASH_MODE = 'clearance';

function mountClashPanel(): string {
  useViewerStore.setState({ clashResult: makeResult(), clashMode: CLASH_MODE });
  render(<ClashPanel onClose={() => {}} />);
  return snapshotRenderedDom(VIEWER_SHELL_SURFACE);
}

// ── Docked panel bodies without their own background ─────────────────────
// ChunkErrorBoundary (panel tone), RoomPanel and LayersPanel are panel bodies
// (lib/panels/renderPanelBody.tsx) that paint no background: the viewer
// shell's ({@link VIEWER_SHELL_SURFACE}, ViewerLayout.tsx) shows through.

function ThrowChunkError(): never {
  throw new Error('Failed to fetch dynamically imported module: https://example/chunk.js');
}

function mountChunkError(): string {
  render(<ChunkErrorBoundary label="Layers panel"><ThrowChunkError /></ChunkErrorBoundary>);
  return snapshotRenderedDom(VIEWER_SHELL_SURFACE);
}

function mountRoomPanel(): string {
  useViewerStore.setState({ collabRoomId: null });
  render(<RoomPanel onClose={() => {}} />);
  return snapshotRenderedDom(VIEWER_SHELL_SURFACE);
}

function mountLayersPanel(): string {
  useViewerStore.setState({ layerStack: [], layerStackDiff: null, layerDiffBusy: false, layerStackPathToId: null });
  render(<LayersPanel onClose={() => {}} />);
  return snapshotRenderedDom(VIEWER_SHELL_SURFACE);
}

// ── CustomizeSidebar ─────────────────────────────────────────────────────
// The popover paints its own `bg-popover`; one panel is hidden so the
// "Hidden" section renders.

function mountCustomizeSidebar(): string {
  const order = useViewerStore.getState().sidebarOrder;
  assert.ok(order.length > 1, 'sidebar has panels to hide');
  useViewerStore.setState({ sidebarHiddenIds: [order[order.length - 1]] });
  render(<CustomizeSidebar onClose={() => {}} />);
  return snapshotRenderedDom(VIEWER_SHELL_SURFACE);
}

// ── RibbonGroup ──────────────────────────────────────────────────────────
// Mounted through RibbonToolbar, whose root carries the real
// `border-b bg-white dark:bg-black` surface (colorful's `.border-b.bg-white`
// violet glass included). With no model loaded the contextual-tab hook shows
// the File tab, expanded.

const RIBBON_GROUP_LABELS = [resolve('ribbon.file.modelGroup'), resolve('ribbon.file.exportGroup')];

function mountRibbon(): string {
  useViewerStore.setState({ ribbonTab: 'file', ribbonCollapsed: false });
  render(<RibbonToolbar />);
  assert.equal(useViewerStore.getState().ribbonTab, 'file');
  return snapshotRenderedDom(VIEWER_SHELL_SURFACE);
}

// ── ClassVisibilityMenu ──────────────────────────────────────────────────
// The open dropdown portals its own `bg-popover` content onto body.

const CLASS_COUNT = /^\d+\/\d+$/;

function mountClassVisibilityMenu(): string {
  render(
    <DropdownMenu open modal={false}>
      <DropdownMenuTrigger>Visibility</DropdownMenuTrigger>
      <ClassVisibilityMenuContent />
    </DropdownMenu>,
  );
  return snapshotRenderedDom();
}

describe('tour and misc panel secondary text clears AA as rendered (#6205, #4792)', () => {
  for (const theme of THEMES) {
    it(`TourStepCard docked-back notice, stuck hint, step count clear AA in ${theme}`, async () => {
      await assertRenderedTextClears(theme, mountTourCard(), [
        resolve('tours.tourStepCard.redockedNotice'),
        resolve('tours.tourStepCard.stuckHint'),
        STEP_COUNT,
      ], WCAG_AA_NORMAL_TEXT);
    });

    it(`LearnTab "X min" readout clears AA in ${theme}`, async () => {
      await assertRenderedTextClears(theme, mountLearnTab(), LEARN_MINUTES, WCAG_AA_NORMAL_TEXT);
    });

    it(`ClashPanel active detection-mode label clears AA in ${theme}`, async () => {
      await assertRenderedTextClears(theme, mountClashPanel(), [CLASH_MODE], WCAG_AA_NORMAL_TEXT);
    });

    it(`ChunkErrorBoundary panel-tone error detail clears AA in ${theme}`, async () => {
      await assertRenderedTextClears(theme, mountChunkError(), [resolve('viewerShell.chunkError.loadFailedDetail')], WCAG_AA_NORMAL_TEXT);
    });

    it(`RoomPanel "Got an invite?" hint clears AA in ${theme}`, async () => {
      await assertRenderedTextClears(theme, mountRoomPanel(), [resolve('zonesPanel.roomPanel.inviteHint')], WCAG_AA_NORMAL_TEXT);
    });

    it(`CustomizeSidebar "Hidden" section header clears AA in ${theme}`, async () => {
      await assertRenderedTextClears(theme, mountCustomizeSidebar(), [resolve('shellChrome.customizeSidebar.hiddenSectionHeader')], WCAG_AA_NORMAL_TEXT);
    });

    it(`RibbonGroup labels on the ribbon toolbar clear AA in ${theme}`, async () => {
      await assertRenderedTextClears(theme, mountRibbon(), RIBBON_GROUP_LABELS, WCAG_AA_NORMAL_TEXT);
    });

    it(`LayersPanel "drop .ifcx files anywhere" hint clears AA in ${theme}`, async () => {
      await assertRenderedTextClears(theme, mountLayersPanel(), [resolve('layersPanel.panel.dropHint')], WCAG_AA_NORMAL_TEXT);
    });

    it(`ClassVisibilityMenu visible/total count clears AA in ${theme}`, async () => {
      await assertRenderedTextClears(theme, mountClassVisibilityMenu(), [CLASS_COUNT], WCAG_AA_NORMAL_TEXT);
    });
  }
});

describe('the measurement catches the pre-#4792 classes on the real sites', () => {
  /** `host` is the surface the site's mount wraps it in (see the mount helpers). */
  const controls: ReadonlyArray<{ site: string; oldClass: string; mount: () => string; text: string; host?: string }> = [
    {
      site: 'ClashPanel mode label',
      oldClass: 'normal-case tracking-normal text-muted-foreground/60',
      mount: mountClashPanel,
      text: CLASH_MODE,
      host: VIEWER_SHELL_SURFACE,
    },
    {
      site: 'TourStepCard stuck hint',
      oldClass: 'text-[11px] text-muted-foreground/80',
      mount: mountTourCard,
      text: resolve('tours.tourStepCard.stuckHint'),
    },
    {
      site: 'ChunkErrorBoundary error detail',
      oldClass: 'text-[10px] text-muted-foreground/70',
      mount: mountChunkError,
      text: resolve('viewerShell.chunkError.loadFailedDetail'),
      host: VIEWER_SHELL_SURFACE,
    },
    {
      site: 'LearnTab "X min"',
      oldClass: 'shrink-0 text-[11px] tabular-nums text-muted-foreground/70',
      mount: mountLearnTab,
      text: LEARN_MINUTES[0],
    },
  ];
  for (const { site, oldClass, mount, text, host } of controls) {
    for (const theme of THEMES) {
      it(`non-vacuousness: ${oldClass} on ${site} reddens in ${theme}`, async (t) => {
        mount();
        const ratios = await assertForcedClassReddens(theme, text, oldClass, WCAG_AA_NORMAL_TEXT, host);
        t.diagnostic(ratios.map((r) => `${r.toFixed(2)}:1`).join(', '));
      });
    }
  }
});
