/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for the #4918 grab-bag "standalone panels, part 1"
 * slice's `misc-panels-a.en.ts` catalogue and its five unrelated
 * consumers, one `describe` block per component: `BasketPresentationDock`,
 * `DeviationPanel`, `ExportChangesReviewDialog`, `ScanSectionPanel`, and
 * `SpaceMousePanel`.
 *
 * Same pseudo-locale-oracle shape as `RoomPanel.i18n.test.tsx`: every
 * catalogue key under the five prefixes is marked, the component is
 * rendered in each branch that surfaces distinct copy, the locale is
 * switched live, and every marked string that was readable in English
 * must reappear marked. Reads keys from `@/i18n/en` (not a per-catalogue
 * dynamic import): a revert of this slice also reverts `en.ts`'s
 * registration of `miscPanelsAEn`, so the filtered catalogue below goes
 * empty and every `assertAllTranslate` call fails on a real "expected
 * English text on screen" assertion rather than silently collecting zero
 * tests.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { resolve } from '@/i18n/registry';
import { en } from '@/i18n/en';
import type { TranslationParameters, TranslationValue, PluralTranslation } from '@/i18n';
import { useViewerStore } from '@/store';
import { BasketPresentationDock } from './BasketPresentationDock.js';
import { DeviationPanel } from './DeviationPanel.js';
import { ExportChangesReviewDialog, type ModelReviewGroup } from './ExportChangesReviewDialog.js';
import { ScanSectionPanel } from './ScanSectionPanel.js';
import { SpaceMousePanel } from './SpaceMousePanel.js';
import type { SpaceMouseDiagnostics } from '@/lib/spacemouse/device';
import type { EffectiveChange } from '@ifc-lite/mutations';
import type { BasketView } from '@/store/slices/pinboardSlice';

const PREFIXES = [
  'basketPresentationDock.',
  'deviationPanel.',
  'exportChangesReviewDialog.',
  'scanSectionPanel.',
  'spaceMousePanel.',
];

const CATALOGUE: Catalogue = Object.fromEntries(
  Object.entries(en).filter(([key]) => PREFIXES.some((p) => key.startsWith(p))),
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
const PSEUDO_LOCALE = 'misc-panels-a-pseudo';

/**
 * A `title`/`aria-label`/`placeholder`/`alt` is always one isolated string,
 * so those stay an exact-match Set. Ordinary text is checked by SUBSTRING
 * against the whole normalized body text instead of an exact-match Set of
 * per-element own-text: several of these components interleave a
 * translated span with sibling text nodes (e.g. `ExportChangesReviewDialog`'s
 * previous/new-value pair around an arrow glyph), so the translated
 * fragment is not always its own element's sole text-node child.
 */
interface DomSnapshot {
  text: string;
  attrs: Set<string>;
}

function snapshotDom(container: HTMLElement): DomSnapshot {
  const attrs = new Set<string>();
  for (const root of [document.body, container]) {
    root.querySelectorAll('*').forEach((el) => {
      for (const attr of ['aria-label', 'title', 'placeholder', 'alt']) {
        const value = el.getAttribute(attr);
        if (value) attrs.add(value);
      }
    });
  }
  const text = (document.body.textContent ?? '').replace(/\s+/g, ' ');
  return { text, attrs };
}

const readableStrings = snapshotDom;

interface Occurrence {
  key: string;
  params?: TranslationParameters;
}

function domHas(dom: DomSnapshot, value: string): boolean {
  return dom.attrs.has(value) || dom.text.includes(value.replace(/\s+/g, ' '));
}

function assertAllTranslate(occurrences: Occurrence[], englishDom: DomSnapshot, afterDom: DomSnapshot): void {
  for (const occ of occurrences) {
    const english = resolve(occ.key as never, occ.params).trim();
    assert.ok(
      domHas(englishDom, english),
      `${occ.key}: expected English text ${JSON.stringify(english)} to be on screen before the locale switch`,
    );
  }
  act(() => setLocale(PSEUDO_LOCALE));
  try {
    for (const occ of occurrences) {
      const pseudo = resolve(occ.key as never, occ.params).trim();
      assert.ok(
        domHas(afterDom, pseudo),
        `${occ.key}: "${pseudo}" must be translated, marked text not found in the switched-locale DOM`,
      );
    }
  } finally {
    act(() => setLocale(BASELINE_LOCALE));
  }
}

function domAfterPseudo(container: HTMLElement): DomSnapshot {
  act(() => setLocale(PSEUDO_LOCALE));
  const snap = snapshotDom(container);
  act(() => setLocale(BASELINE_LOCALE));
  return snap;
}

const RESET_STATE = {
  pinboardEntities: new Set<string>(),
  isolatedEntities: null,
  basketViews: [] as BasketView[],
  activeBasketViewId: null,
  basketPresentationVisible: false,
  isMobile: false,
  spaceMousePanelOpen: false,
  spaceMouseSupported: false,
  spaceMouseConnected: false,
  spaceMouseDeviceName: null,
  spaceMouseError: null,
  spaceMouseGetDiagnostics: null,
};

beforeEach(() => {
  registerLocale(PSEUDO_LOCALE, PSEUDO);
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState(RESET_STATE);
});

afterEach(() => {
  cleanup();
  setLocale(BASELINE_LOCALE);
  useViewerStore.setState(RESET_STATE);
});

describe('BasketPresentationDock localization (#4918)', () => {
  it('translates the collapsed trigger', () => {
    useViewerStore.setState({ basketPresentationVisible: false });
    const container = render(<BasketPresentationDock />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [{ key: 'basketPresentationDock.presentationLabel' }],
      englishDom,
      afterDom,
    );
  });

  it('translates the expanded dock header, empty strip, and control titles', () => {
    useViewerStore.setState({ basketPresentationVisible: true });
    const container = render(<BasketPresentationDock />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'basketPresentationDock.dragToMoveTitle' },
        { key: 'basketPresentationDock.presentationLabel' },
        { key: 'basketPresentationDock.inBasketCount', params: { count: 0 } },
        { key: 'basketPresentationDock.viewsCount', params: { count: 0 } },
        { key: 'basketPresentationDock.setFromContextTitle' },
        { key: 'basketPresentationDock.addToBasketTitle' },
        { key: 'basketPresentationDock.removeFromBasketTitle' },
        { key: 'basketPresentationDock.showActiveBasketTitle' },
        { key: 'basketPresentationDock.clearActiveBasketTitle' },
        { key: 'basketPresentationDock.saveCurrentViewTitle' },
        { key: 'basketPresentationDock.playAllTitle' },
        { key: 'basketPresentationDock.hideButton' },
        { key: 'basketPresentationDock.scrollLeftTitle' },
        { key: 'basketPresentationDock.scrollRightTitle' },
        { key: 'basketPresentationDock.resizeWidthTitle' },
        { key: 'basketPresentationDock.emptyStripHint' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates a saved-view card: active badge, object/transition counts, and per-card titles', () => {
    useViewerStore.setState({
      basketPresentationVisible: true,
      activeBasketViewId: 'view-1',
      basketViews: [
        {
          id: 'view-1',
          name: 'My View',
          entityRefs: ['a', 'b'],
          thumbnailDataUrl: null,
          transitionMs: 1500,
          viewpoint: null,
          section: null,
          source: 'manual',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    });
    const container = render(<BasketPresentationDock />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'basketPresentationDock.activeBadge' },
        { key: 'basketPresentationDock.objectsCount', params: { count: 2 } },
        { key: 'basketPresentationDock.transitionSuffix', params: { duration: '1.5' } },
        { key: 'basketPresentationDock.renameViewTitle' },
        { key: 'basketPresentationDock.setTransitionTitle' },
        { key: 'basketPresentationDock.deleteViewTitle' },
        { key: 'basketPresentationDock.viewsCount', params: { count: 1 } },
      ],
      englishDom,
      afterDom,
    );
  });
});

describe('DeviationPanel localization (#4918)', () => {
  it('translates the section label and compute button before any result', () => {
    const triangleCount = 1000;
    const container = render(<DeviationPanel triangleCount={triangleCount} />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'deviationPanel.sectionLabel' },
        { key: 'deviationPanel.computeButtonTitle', params: { count: triangleCount.toLocaleString() } },
        { key: 'deviationPanel.computeLabel' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('hides entirely with no triangles in the scene', () => {
    const container = render(<DeviationPanel triangleCount={0} />);
    assert.equal(container.textContent, '');
  });
});

describe('ExportChangesReviewDialog localization (#4918)', () => {
  it('translates the empty state and footer controls', () => {
    const container = render(
      <ExportChangesReviewDialog
        open
        onOpenChange={() => {}}
        groups={[]}
        totalCount={0}
        isExporting={false}
        onConfirm={() => {}}
      />,
    );
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'exportChangesReviewDialog.title' },
        { key: 'exportChangesReviewDialog.noPendingChanges' },
        { key: 'exportChangesReviewDialog.emptyStateMessage' },
        { key: 'exportChangesReviewDialog.cancelButton' },
        { key: 'exportChangesReviewDialog.exportButton' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates the changes summary, per-change-kind labels, and value fallbacks for a real diff', () => {
    const changes: EffectiveChange[] = [
      { kind: 'attribute', entityId: 42, name: 'Name', previousValue: 'Old', newValue: 'New' },
      { kind: 'property', entityId: 42, setName: 'Pset_WallCommon', name: 'IsExternal', deleted: true },
    ];
    const groups: ModelReviewGroup[] = [
      {
        modelId: 'model-1',
        modelName: 'Model A',
        entities: [{ entityId: 42, label: 'IfcWall #42', changes }],
        unitemizedCount: 3,
      },
    ];
    const container = render(
      <ExportChangesReviewDialog
        open
        onOpenChange={() => {}}
        groups={groups}
        totalCount={5}
        isExporting={false}
        onConfirm={() => {}}
      />,
    );
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'exportChangesReviewDialog.kindAttribute', params: { name: 'Name' } },
        { key: 'exportChangesReviewDialog.kindProperty', params: { set: 'Pset_WallCommon', name: 'IsExternal' } },
        { key: 'exportChangesReviewDialog.deletedValue' },
        { key: 'exportChangesReviewDialog.unitemizedNote', params: { count: 3 } },
      ],
      englishDom,
      afterDom,
    );

    // `changesSummary` nests a second `t()` call (`modelsCount`) inside its
    // own template, the same shape as `SpaceMousePanel`'s `layoutLine` above
    // — resolve both the inner and outer piece at the SAME locale on each
    // side, rather than freezing the inner value from before the switch.
    const summaryParams = (): TranslationParameters => ({
      count: 5,
      models: resolve('exportChangesReviewDialog.modelsCount' as never, { count: 1 }),
      fileSuffix: '',
    });
    const englishSummary = resolve('exportChangesReviewDialog.changesSummary' as never, summaryParams()).trim();
    assert.ok(domHas(englishDom, englishSummary), 'expected the English changes-summary line on screen before the locale switch');
    act(() => setLocale(PSEUDO_LOCALE));
    let pseudoSummary: string;
    try {
      pseudoSummary = resolve('exportChangesReviewDialog.changesSummary' as never, summaryParams()).trim();
    } finally {
      act(() => setLocale(BASELINE_LOCALE));
    }
    assert.ok(domHas(afterDom, pseudoSummary), `expected the changes-summary line to translate to ${JSON.stringify(pseudoSummary)}`);
  });
});

describe('ScanSectionPanel localization (#4918)', () => {
  it('translates the header, toggle labels, and the no-point-cloud message', () => {
    const container = render(
      <ScanSectionPanel onClose={() => {}} hasPointCloud={false} totalInBand={0} renderedCount={0} />,
    );
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'scanSectionPanel.title' },
        { key: 'scanSectionPanel.closeAriaLabel' },
        { key: 'scanSectionPanel.showScanPointsLabel' },
        { key: 'scanSectionPanel.noPointCloudMessage' },
        { key: 'scanSectionPanel.includeInExportLabel' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates the band-thickness/opacity labels and the partial-decimation footnote with a point cloud loaded', () => {
    const container = render(
      <ScanSectionPanel onClose={() => {}} hasPointCloud totalInBand={5000} renderedCount={1200} />,
    );
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    const thicknessValue = `${Math.round(0.3 * 1000)} mm`; // DEFAULT_SCAN_SECTION_THICKNESS
    assertAllTranslate(
      [
        { key: 'scanSectionPanel.bandThicknessLabel', params: { value: thicknessValue } },
        { key: 'scanSectionPanel.thicknessSliderTitle' },
        { key: 'scanSectionPanel.dotOpacityLabel', params: { percent: 90 } },
        {
          key: 'scanSectionPanel.showingPartialMessage',
          params: { rendered: (1200).toLocaleString(), total: (5000).toLocaleString() },
        },
      ],
      englishDom,
      afterDom,
    );
  });
});

describe('SpaceMousePanel localization (#4918)', () => {
  it('translates the header and the no-WebHID-support message', () => {
    useViewerStore.setState({ spaceMousePanelOpen: true, spaceMouseSupported: false });
    const container = render(<SpaceMousePanel />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'spaceMousePanel.dragToMoveTitle' },
        { key: 'spaceMousePanel.headerLabel' },
        { key: 'spaceMousePanel.noWebHidMessage' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates the connect button and sensitivity controls when supported but not connected', () => {
    useViewerStore.setState({ spaceMousePanelOpen: true, spaceMouseSupported: true, spaceMouseConnected: false });
    const container = render(<SpaceMousePanel />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'spaceMousePanel.connectButton' },
        { key: 'spaceMousePanel.sensitivityLabel' },
        { key: 'spaceMousePanel.resetSensitivityTitle' },
        { key: 'spaceMousePanel.guidanceMessage' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates the connected/disconnect row and device-name fallback', () => {
    useViewerStore.setState({
      spaceMousePanelOpen: true,
      spaceMouseSupported: true,
      spaceMouseConnected: true,
      spaceMouseDeviceName: null,
    });
    const container = render(<SpaceMousePanel />);
    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'spaceMousePanel.deviceNameFallback' },
        { key: 'spaceMousePanel.disconnectTitle' },
        { key: 'spaceMousePanel.disconnectButton' },
      ],
      englishDom,
      afterDom,
    );
  });

  it('translates the diagnostics readout: layout line, report line, and copy button', () => {
    const diag: SpaceMouseDiagnostics = {
      productName: 'Test Device',
      vendorId: 1,
      productId: 2,
      layoutSource: 'descriptor',
      layoutAxes: 6,
      axes: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      lastSampleAt: 0,
      buttonsDown: [],
      reports: [{ reportId: 1, count: 42, byteLength: 7, lastBytesHex: 'AA BB' }],
      buildDump: () => '{}',
    };
    useViewerStore.setState({
      spaceMousePanelOpen: true,
      spaceMouseSupported: true,
      spaceMouseConnected: true,
      spaceMouseDeviceName: 'Test Device',
      spaceMouseGetDiagnostics: () => diag,
    });
    const container = render(<SpaceMousePanel />);
    // Open the Diagnostics disclosure so its contents mount.
    const diagButton = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.includes(resolve('spaceMousePanel.diagnosticsLabel' as never)),
    );
    assert.ok(diagButton, 'expected a Diagnostics toggle button');
    act(() => diagButton!.click());

    const englishDom = readableStrings(container);
    const afterDom = domAfterPseudo(container);
    assertAllTranslate(
      [
        { key: 'spaceMousePanel.diagnosticsLabel' },
        { key: 'spaceMousePanel.reportLine', params: { id: 1, count: 42, bytes: 7, hex: 'AA BB' } },
        { key: 'spaceMousePanel.copyDeviceReportLabel' },
      ],
      englishDom,
      afterDom,
    );

    // `layoutLine` nests a second `t()` call (the descriptor/built-in-fallback
    // sub-label) inside its own template, the same shape as `RoomPanel`'s
    // `statusRoom` — check English and pseudo forms with BOTH the inner and
    // outer resolved at the SAME locale, rather than freezing the inner
    // value from before the switch.
    const englishLayoutLine = resolve('spaceMousePanel.layoutLine' as never, {
      value: resolve('spaceMousePanel.layoutDescriptor' as never, { axes: 6 }),
    }).trim();
    assert.ok(domHas(englishDom, englishLayoutLine), 'expected the English layout line on screen before the locale switch');
    act(() => setLocale(PSEUDO_LOCALE));
    let pseudoLayoutLine: string;
    try {
      pseudoLayoutLine = resolve('spaceMousePanel.layoutLine' as never, {
        value: resolve('spaceMousePanel.layoutDescriptor' as never, { axes: 6 }),
      }).trim();
    } finally {
      act(() => setLocale(BASELINE_LOCALE));
    }
    assert.ok(domHas(afterDom, pseudoLayoutLine), `expected the layout line to translate to ${JSON.stringify(pseudoLayoutLine)}`);
  });
});
