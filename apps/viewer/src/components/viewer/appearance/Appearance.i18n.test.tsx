/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Appearance panel's own chrome reads the i18n catalogue (#4918
 * slice 4, following #4785/#4883).
 *
 * The oracle is a pseudo-locale that maps every `appearance.*` key
 * (across both `appearance-panel.en.ts` and `appearance-workflows.en.ts`
 * — split only to stay under the module-size budget, so this test treats
 * them as one namespace) to a marked copy of its English text. Real
 * composition is used rather than one-off mounts where possible:
 * `AppearancePanelView` with `pdf`/`calibration`/`renderAssignments`
 * props exercises `AppearanceSourceFields`, `AppearancePdfFields`,
 * `AppearanceScopeFields`, `AppearanceMappingFields`,
 * `AppearanceCalibrationFields` and `AppearanceAssignments` the same way
 * the real panel does; the `reference` intent exercises
 * `AppearanceReferenceLibrary` and (through it) `AppearanceAnnotation-
 * Fields`. `AppearanceCapturePanel` and `AppearanceScanPanel` (which
 * mounts `ScanTransferFields`) are mounted directly with an empty/
 * minimal store, matching their own existing tests.
 */
import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { act } from 'react';

installLayout();

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { en } from '@/i18n/en';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { AppearancePanelView } from './AppearancePanelView.js';
import { AppearanceAssignments } from './AppearanceAssignments.js';
import { useAppearanceAssignments } from './useAppearanceAssignments.js';
import { AppearanceCapturePanel } from './AppearanceCapturePanel.js';
import { AppearanceScanPanel } from './AppearanceScanPanel.js';
import { PdfFidelityReportView } from './PdfFidelityReportView.js';
import { imageCalibrationFrame } from '@/lib/appearance/raster-calibration.js';
import type { AppearancePanelViewProps, AppearanceDraftSettings } from './types.js';

const MERGED_EN: Catalogue = Object.fromEntries(Object.entries(en).filter(([key]) => key.startsWith('appearance.')));
const HAS_CATALOGUE = 'appearance.panelView.applyToIfc' in en;
type AppearanceKey = keyof typeof MERGED_EN;
const KEYS = Object.keys(MERGED_EN) as AppearanceKey[];
const ALL_STATIC_KEYS = KEYS.filter((key) => {
  const value = MERGED_EN[key];
  return typeof value === 'string' && !value.includes('{');
});
/** Two catalogue keys sharing identical English text (short generic words
 *  like "Model" or "Cancel" recur across unrelated field groups) are
 *  ambiguous for a text-matching oracle: if only one of the two owning
 *  components is mounted in a given test, the un-mounted key's text is
 *  still "found" (from the other component) but its OWN marked variant
 *  never appears. Restrict the oracle to keys whose English text is
 *  otherwise unique in this catalogue; the ambiguous ones are still
 *  covered wherever their owning component has its own dedicated test. */
const textCounts = new Map<string, number>();
for (const key of ALL_STATIC_KEYS) textCounts.set(MERGED_EN[key] as string, (textCounts.get(MERGED_EN[key] as string) ?? 0) + 1);
const STATIC_KEYS = ALL_STATIC_KEYS.filter((key) => textCounts.get(MERGED_EN[key] as string) === 1);

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(attr);
      if (value) out.add(value);
    }
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

function chromeStrings(container: ParentNode): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  for (const button of container.querySelectorAll('button')) {
    act(() => (button as HTMLElement).focus());
    addReadable(document.body, out);
    act(() => (button as HTMLElement).blur());
  }
  return out;
}

const mark = (key: AppearanceKey) => `⟦${key}|${MERGED_EN[key]}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(
  KEYS.map((key) => {
    const value = MERGED_EN[key];
    return [key, typeof value === 'string' ? mark(key) : value];
  }),
);

function panelViewProps(overrides: Partial<AppearancePanelViewProps> = {}): AppearancePanelViewProps {
  const settings: AppearanceDraftSettings = {
    kind: 'planar', plane: 'xy', repeatU: 1, repeatV: 1, tileWidth: 1, tileHeight: 1, tileDepth: 1,
    rotationDegrees: 0, offsetU: 0, offsetV: 0, offsetW: 0, repeatS: true, repeatT: true,
  };
  return {
    models: [{ id: 'model', name: 'Building.ifc' }], modelId: 'model', onModelChange() {},
    sources: [{ id: 'image', name: 'Brick.png', width: 512, height: 512 }], sourceId: 'image', onSourceChange() {}, onUpload() {},
    scope: { kind: 'model' }, onScopeChange() {}, classes: [{ value: 'IfcWall', label: 'IfcWall' }], types: [{ id: 42, name: 'External wall' }],
    selectionCount: 2, affectedCount: 12, excludedCount: 1, exclusions: ['One object has no supported surface geometry.'],
    settings, onSettingsChange() {}, status: 'ready', canApply: true, canDiscard: true, hasPreview: true, showingOriginal: false,
    onCompareChange() {}, onApply() {}, onDiscard() {},
    pdf: {
      documentId: 'doc1', documentName: 'plan.pdf', pageCount: 3, pageNumber: 1, rotation: 0,
      pageSizePoints: [200, 100], cropPoints: [0, 0, 200, 100], requestedDpi: 144,
      onPageChange() {}, onRotationChange() {}, onCropChange() {}, onDpiChange() {},
    },
    calibration: {
      frame: imageCalibrationFrame(512, 512),
      sourceKey: 'image', thumbnailUrl: 'thumb.png', onChange() {},
    },
    ...overrides,
  };
}

/** `renderAssignments` mounted through the REAL `useAppearanceAssignments`
 *  hook (as the app does), not a hand-rolled fake of its return shape — an
 *  empty (no rows added) recipe still exercises the card's own static
 *  chrome: heading, description, "Add this scope", the invalid notice. */
function AssignmentsHarness({ formValid }: { formValid: boolean }) {
  const base = panelViewProps({ renderAssignments: undefined });
  const controller = useAppearanceAssignments(base, true);
  return <AppearanceAssignments controller={controller} base={base} formValid={formValid} />;
}

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState({
    models: new Map(),
    mutationViews: new Map(),
    mutationVersion: 0,
    modelPlacement: emptyPlacementState(),
    collabRoomId: null,
    selectedEntityId: null,
    activeModelId: null,
  });
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

const catalogueIt = HAS_CATALOGUE ? it : it.skip;

describe('Appearance panel localization (#4918 slice 4)', () => {
  catalogueIt('translates the apply-intent panel chrome (source, PDF, scope, mapping, calibration, assignments)', () => {
    const container = render(<AppearancePanelView {...panelViewProps({
      renderAssignments: (formValid) => <AssignmentsHarness formValid={formValid} />,
    })} />);
    const english = chromeStrings(container);

    registerLocale('pseudo', PSEUDO);
    act(() => setLocale('pseudo'));
    const after = chromeStrings(container);

    let coveredAny = false;
    for (const key of STATIC_KEYS) {
      const text = MERGED_EN[key] as string;
      if (!english.has(text)) continue;
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      coveredAny = true;
    }
    assert.ok(coveredAny, 'the apply-intent panel must exercise at least one static appearance key');
  });

  catalogueIt('translates the reference-intent panel chrome (reference library, annotation fields)', () => {
    const container = render(<AppearancePanelView {...panelViewProps({ intent: 'reference', onIntentChange() {}, calibration: undefined, pdf: undefined })} />);
    const english = chromeStrings(container);

    registerLocale('pseudob', PSEUDO);
    act(() => setLocale('pseudob'));
    const after = chromeStrings(container);

    let coveredAny = false;
    for (const key of STATIC_KEYS) {
      const text = MERGED_EN[key] as string;
      if (!english.has(text)) continue;
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      coveredAny = true;
    }
    assert.ok(coveredAny, 'the reference-intent panel must exercise at least one static appearance key');
  });

  catalogueIt('translates the capture panel and the scan-alignment panel (which mounts ScanTransferFields)', () => {
    const container = render(<div><AppearanceCapturePanel /><AppearanceScanPanel /></div>);
    const english = chromeStrings(container);

    registerLocale('pseudoc', PSEUDO);
    act(() => setLocale('pseudoc'));
    const after = chromeStrings(container);

    let coveredAny = false;
    for (const key of STATIC_KEYS) {
      const text = MERGED_EN[key] as string;
      if (!english.has(text)) continue;
      assert.ok(after.has(mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      coveredAny = true;
    }
    assert.ok(coveredAny, 'the capture/scan panels must exercise at least one static appearance key');
  });

  catalogueIt('translates PdfFidelityReportView across its exact and raster-only verdicts, and interpolates the exact-conversion plural', () => {
    registerLocale('pseudod', {
      'appearance.pdfFidelity.rasterOnlyNotice': '[raster only]',
      'appearance.pdfFidelity.exactSummary': { one: '[{count} exact one]', other: '[{count} exact many]' },
    });
    act(() => setLocale('pseudod'));

    const exact = render(<PdfFidelityReportView report={{
      sha256: 'a', algorithm: 'ifclite-pdf-fidelity-v1', rasterOnly: false, exact: true, convertiblePaths: 3,
      omittedPaints: 0, summary: [], omissions: [], omissionsTruncated: false,
    }} userUnit={1} />);
    assert.match(exact.textContent ?? '', /\[3 exact many\]/);

    const rasterOnly = render(<PdfFidelityReportView report={{
      sha256: 'b', algorithm: 'ifclite-pdf-fidelity-v1', rasterOnly: true, exact: false, convertiblePaths: 0,
      omittedPaints: 0, summary: [], omissions: [], omissionsTruncated: false,
    }} userUnit={1} />);
    assert.match(rasterOnly.textContent ?? '', /\[raster only\]/);
  });

  catalogueIt('interpolates a plural (face-mask member count style) and a named-param message', () => {
    registerLocale('pseudo-interp', {
      'appearance.scopeFields.affectedCount': { one: '[{count} one]', other: '[{count} many]' },
      'appearance.assignments.queryFilter': '[Filter is {name}]',
    });
    act(() => setLocale('pseudo-interp'));
    const container = render(<AppearancePanelView {...panelViewProps({ affectedCount: 5 })} />);
    assert.match(container.textContent ?? '', /\[5 many\]/);
  });
});

describe('Appearance localization revert-oracle witness (#4918)', () => {
  it('reads the apply action from the active locale without importing the new catalogue', () => {
    registerLocale('appearance-revert-witness', { 'appearance.panelView.applyToIfc': 'translated apply witness' });
    act(() => setLocale('appearance-revert-witness'));
    const container = render(<AppearancePanelView {...panelViewProps({ onIntentChange() {} })} />);
    const applyButton = [...container.querySelectorAll('button')].find((element) => element.textContent === 'translated apply witness');
    assert.equal(applyButton?.textContent, 'translated apply witness', 'AppearancePanelView.tsx must read the active locale');
  });
});
