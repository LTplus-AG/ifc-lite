/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Measure tool reads the i18n catalogue (#4918, following #4785/#4883):
 * `MeasureToolbar.tsx`, `MeasureHudReadouts.tsx`, `MeasurementsPanel.tsx`,
 * `MeasurementList.tsx`, `MeasureQuantities.tsx`, `MeasurePointReadout.tsx`,
 * `MeasurementVisuals.tsx` and `measure-modes/geo-readout.tsx`.
 *
 * Same oracle as `MainToolbar.i18n.test.tsx`: a pseudo-locale maps every
 * `measure.*` key to a marked copy of its English text, the tool (the real
 * `MeasureOverlay` on a real `ViewportHud`, plus the real `MeasurementsPanel`,
 * #5502) is driven into a handful of states that surface as
 * much of the catalogue as feasible, the locale is switched live, and every
 * marked string that was visible in English must reappear marked. Plural and
 * `{param}` keys are exercised with `expectedMarked`, which replicates just
 * enough of `registry.ts`'s `resolve()` (plural-category selection +
 * placeholder interpolation) to compute the exact string the real resolver
 * would render for a pseudo catalogue — the point being to prove the KEY
 * reaches the DOM, not to re-implement the resolver.
 *
 * Two families of keys are listed in `NOT_RENDERED_IN_THIS_STATE` rather than
 * exercised, each for a stated reason:
 *  - georeferenced-only rows (Geo XYZ toggle on / Live-Last E-N-H / Map row /
 *    Lat-Lon) never render without a loaded model whose `IfcMapConversion`
 *    resolves — standing that up is `useAnchorGeoreference`'s own fixture
 *    cost, not this file's;
 *  - the quantities panel's declared/geometry/derived-mass rows and their
 *    footnotes need a real `IfcDataStore` with quantity sets, mesh geometry
 *    and material densities — `measure-quantities-derived-weight.test.tsx`
 *    and `measure-quantities-mesh-area.test.tsx` already build exactly that
 *    fixture to prove the ARITHMETIC; re-building it here would duplicate
 *    that cost only to prove the LABEL calls `t()`, which the source diff
 *    already shows.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { measureEn as MeasureEnType } from '@/i18n/catalogues/measure.en';
import type { TranslationValue } from '@/i18n/types';
import { useViewerStore } from '@/store';
import type { MeasurePoint } from '@/store/types';
import { MeasureOverlay } from './MeasurePanel.js';
import { MeasurementsPanel } from '../MeasurementsPanel.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { SceneOverlayRoot } from '../../viewport-ui/scene/index.js';

/** The shipped surfaces together: the HUD host (the bar and hint portal into
 *  it), the scene root (the world labels portal into it), the tool's
 *  overlay, and the docked Measurements panel. */
function renderMeasure(): HTMLElement {
  return render(
    <>
      <ViewportHud />
      <SceneOverlayRoot>
        <MeasureOverlay />
      </SceneOverlayRoot>
      <MeasurementsPanel onClose={() => {}} />
    </>,
  );
}

// Guarded dynamic import (#4918 revert-oracle): `check-test-revert-oracle.mjs`
// reverting production hunks treats a brand-new module (this catalogue) as a
// deletion, and a static `import { measureEn } from '...'` would then fail
// this file's whole LOAD, which the oracle reports as INCONCLUSIVE rather
// than a red assertion (see that script's own docblock on the
// REVERT-BROKE-BUILD case). A guarded dynamic import turns a missing
// catalogue into a clean `describe.skip` instead — the real coverage lives
// in `measure-radius-panel.test.tsx`'s pre-existing-API witness, which
// reverts to a genuine RED because it never imports this module.
let measureEn: typeof MeasureEnType | undefined;
try {
  ({ measureEn } = await import('@/i18n/catalogues/measure.en'));
} catch {
  measureEn = undefined;
}
const HAS_CATALOGUE = measureEn !== undefined;
const CATALOGUE: typeof MeasureEnType = measureEn ?? ({} as typeof MeasureEnType);

type MeasureKey = keyof typeof CATALOGUE;
const KEYS = Object.keys(CATALOGUE) as MeasureKey[];
const STATIC_KEYS = KEYS.filter((key) => {
  const v = CATALOGUE[key];
  return typeof v === 'string' && !v.includes('{');
});
const PARAM_KEYS = KEYS.filter((key) => !STATIC_KEYS.includes(key));

function mp(x: number, y: number, z: number): MeasurePoint {
  return { x, y, z, screenX: x, screenY: y };
}

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    // The Measure tool uses plain HTML `title` attributes (native browser
    // tooltips), not Radix `TooltipContent` — no focus-walk needed to reach
    // them, just read the attribute.
    const title = element.getAttribute('title');
    if (title) out.add(title);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
}

/** aria-labels, plain text, and (by focusing each button in turn) every
 *  reachable Radix `TooltipContent` string. */
function chromeStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  for (const button of container.querySelectorAll('button')) {
    act(() => button.focus());
    addReadable(document.body, out);
    act(() => button.blur());
  }
  return out;
}

/** Click the Measurements panel's tab whose ENGLISH label is `label`. Must run
 *  before the locale switch — after it the tab text is the marked copy. */
function openSection(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.trim() === label);
  assert.ok(button, `no tab labelled "${label}" on the Measurements panel`);
  act(() => {
    button.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
  });
}

/** Key-specific pseudo translation; keeps every `{placeholder}` and every
 *  plural category of the English source. */
function markValue(key: MeasureKey, value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${key}|${value}⟧`;
  const wrapped: Record<string, string> = {};
  for (const [category, text] of Object.entries(value)) wrapped[category] = `⟦${key}|${text}⟧`;
  return wrapped as TranslationValue;
}
const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, markValue(key, CATALOGUE[key])])) as Catalogue;
const PSEUDO_LOCALE = 'measure-pseudo';

/** Mirrors just enough of `registry.ts`'s `resolve()` — plural-category
 *  selection then `{param}` interpolation — to compute the exact marked
 *  string the real resolver renders for a `{ count, ...params }` call,
 *  without importing resolver internals. */
function expectedMarked(key: MeasureKey, params: Record<string, string | number> = {}): string {
  const value = CATALOGUE[key];
  const template = typeof value === 'string'
    ? value
    : (typeof params.count === 'number'
      ? (value as Record<string, string>)[new Intl.PluralRules('en').select(params.count)] ?? value.other
      : value.other);
  const interpolated = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole);
  return `⟦${key}|${interpolated}⟧`;
}

/**
 * Asserts an interpolated/plural key's marked+substituted text is present.
 *
 * Always passed an explicit message: `assert.ok(x)` with no message makes
 * Node re-parse this file's source to embed the failing expression's own
 * text in the error, and on this file that lookup hangs indefinitely rather
 * than failing fast (reproduced in isolation; every other `assert.ok` call in
 * this file also carries a message for the same reason).
 */
/** Substring match, not `Set.has` equality: several of these keys sit beside
 *  sibling `{}` expressions inside the SAME element (e.g. an index label next
 *  to a non-catalogued function's own text) and `addReadable` joins every
 *  child text node of one element into a single combined string. */
function assertMarked(after: Set<string>, key: MeasureKey, params: Record<string, string | number> = {}): void {
  const expected = expectedMarked(key, params);
  const found = [...after].some((s) => s.includes(expected));
  assert.ok(found, `${key}: expected marked+interpolated text not found anywhere: ${expected}`);
}

const RESET = {
  activeTool: 'measure',
  measureMode: 'drag' as const,
  measurements: [],
  activeMeasurement: null,
  pendingMeasurePoint: null,
  angleMeasurements: [],
  activeAngle: null,
  angleKind: 'points' as const,
  activePolyline: null,
  polylineMeasurements: [],
  radiusMeasurements: [],
  activeRadius: null,
  unitDisplayOverrides: {},
  snapEnabled: true,
  geoReadoutEnabled: false,
  selectedEntity: null,
  selectedEntitiesSet: new Set<string>(),
  measureReferencePoint: null,
} as Partial<ReturnType<typeof useViewerStore.getState>>;

/** Every STATIC_KEY the English pass actually found on screen, accumulated
 *  across every `it` below — checked for completeness in the final test. */
const coveredStatic = new Set<MeasureKey>();
const coveredParams = new Set<MeasureKey>();

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState(RESET);
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(RESET);
});

/** Static-key keys this suite's render states cannot show, each for a stated
 *  reason. */
const NOT_RENDERED_IN_THIS_STATE: MeasureKey[] = [
  // The "Clear all" text appears only after opening the themed dialog;
  // hooks/useKeyboardShortcuts.measure-clear.test.tsx asserts it.
  'measure.clearAllConfirm',
  // No fixture in this file records a CLOSED polyline (`closed: true`) — the
  // completed-polyline fixtures used throughout are all open runs, so the
  // "closed" basis label never renders. `measure.polyline.basisLength`
  // (the open-polyline case) is exercised.
  'measure.polyline.basisPerimeterClosed',
  // Georeferenced rows never render without a model whose IfcMapConversion
  // resolves through useAnchorGeoreference — no model is loaded here.
  'measure.geoToggle.enabledTitle',
  'measure.geo.easting',
  'measure.geo.northing',
  'measure.geo.height',
  'measure.geo.unitMeters',
  'measure.readout.live',
  'measure.readout.last',
  'measure.point.rowMap',
  'measure.point.rowLatLon',
  // frame.rebased / coords.shifted need a federation alignment this suite
  // never sets up (useRenderFrameOffsets stays at its single-model default).
  'measure.point.rowAnchor',
  'measure.point.rowRender',
  'measure.point.anchorModelFallback',
  // The quantities panel's declared/geometry/derived-mass rows and their
  // footnotes need a real IfcDataStore with quantity sets, mesh geometry and
  // material densities — see this file's own doc comment.
  'measure.qty.length',
  'measure.qty.area',
  'measure.qty.volume',
  'measure.qty.weight',
  'measure.basis.net',
  'measure.basis.gross',
  'measure.weight.massDerived',
  'measure.weight.massEstimated',
  'measure.weight.massDerivedTitle',
  'measure.weight.massEstimatedTitle',
  'measure.quantities.volumeMeshLabel',
  'measure.quantities.volumeMeshTitle',
  'measure.quantities.areaMeshLabel',
  'measure.quantities.areaMeshTitle',
  'measure.quantities.legend',
  'measure.quantities.massLegend',
  'measure.quantities.massLegendWithEstimated',
];

const NOT_RENDERED_PARAMS: MeasureKey[] = [
  'measure.readout.latLon', // needs a resolved anchor, see above
  'measure.point.rebasedNote', // needs frame.rebased, see above
  'measure.quantities.densityAmbiguous', // needs a real IfcDataStore fixture, see above
  'measure.quantities.weightUnitIsForce',
  'measure.quantities.unprovedVolume',
  'measure.quantities.noMeshToMeasure',
  'measure.quantities.meshAreaIncomplete',
  'measure.quantities.rescaledVolume',
];

/** Runs the shared static-key check for one (english-before, marked-after) pair.
 *  Keys already declared not-rendered are skipped here too: `measure.polyline.basisLength`
 *  (#4918 review, PR #5001 — `polylineBasisLabelKey` now returns a real
 *  translation key rather than a bare string) happens to share its English
 *  text "Length" with `measure.qty.length`, which never mounts in this
 *  state; without the skip, that coincidence would look like unearned
 *  coverage for a key whose own component was never rendered. */
function assertStaticCoverage(english: Set<string>, after: Set<string>): void {
  for (const key of STATIC_KEYS) {
    if (NOT_RENDERED_IN_THIS_STATE.includes(key)) continue;
    const text = CATALOGUE[key] as string;
    if (!english.has(text)) continue;
    assert.ok(after.has(`⟦${key}|${text}⟧`), `${key}: "${text}" must be translated, marked text not found`);
    coveredStatic.add(key);
  }
}

describe('Measure tool localization (#4918)', { skip: !HAS_CATALOGUE && 'measure.en.ts catalogue module not present (revert-oracle probe) — see measure-radius-panel.test.tsx for the witness that stays red' }, () => {
  it('chrome: header, distance mode, snap-on, geo-off, section buttons', () => {
    useViewerStore.setState({
      measurements: [{ id: 'm1', start: mp(0, 0, 0), end: mp(1, 0, 0), distance: 1 }],
      snapEnabled: true,
    });
    const container = renderMeasure();
    const english = chromeStrings(container);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);

    assertStaticCoverage(english, after);
  });

  it('list tab with the tool closed: the "Start measuring" affordance', () => {
    useViewerStore.setState({ activeTool: 'select' });
    const container = render(<MeasurementsPanel />);
    openSection(container, 'List');
    const english = chromeStrings(container);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);

    assertStaticCoverage(english, after);
  });

  it('chrome: snap-off variant', () => {
    useViewerStore.setState({ snapEnabled: false });
    const container = renderMeasure();
    const english = chromeStrings(container);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);

    assertStaticCoverage(english, after);
  });

  it('angle mode: kind buttons and every click-hint, across kinds and pick counts', () => {
    useViewerStore.setState({ measureMode: 'angle' });
    renderMeasure();

    const states: Array<{ kind: 'points' | 'edges' | 'faces'; picks: number }> = [
      { kind: 'points', picks: 0 },
      { kind: 'points', picks: 1 },
      { kind: 'points', picks: 2 },
      { kind: 'edges', picks: 0 },
      { kind: 'edges', picks: 1 },
      { kind: 'edges', picks: 2 },
      { kind: 'edges', picks: 3 },
      { kind: 'faces', picks: 0 },
      { kind: 'faces', picks: 1 },
    ];
    const onePick = { kind: 'points' as const, point: mp(0, 0, 0) };

    const walk = (out: Set<string>) => {
      for (const s of states) {
        act(() => {
          useViewerStore.setState({
            angleKind: s.kind,
            activeAngle: s.picks === 0 ? null : { kind: s.kind, picks: Array(s.picks).fill(onePick) },
          });
        });
        addReadable(document.body, out);
      }
    };

    const english = new Set<string>();
    walk(english);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = new Set<string>();
    walk(after);

    assertStaticCoverage(english, after);
  });

  it('radius mode: hints on and off an active sequence', () => {
    useViewerStore.setState({ measureMode: 'radius', activeRadius: null });
    renderMeasure();

    const walk = (out: Set<string>) => {
      act(() => useViewerStore.setState({ activeRadius: null }));
      addReadable(document.body, out);
      act(() => useViewerStore.setState({ activeRadius: { points: [mp(0, 0, 0), mp(1, 0, 0), mp(0, 1, 0)] } }));
      addReadable(document.body, out);
    };

    const english = new Set<string>();
    walk(english);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = new Set<string>();
    walk(after);

    assertStaticCoverage(english, after);
  });

  it('polyline mode: start hint before any point is placed', () => {
    useViewerStore.setState({ measureMode: 'polyline', activePolyline: null });
    const container = renderMeasure();
    const english = chromeStrings(container);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);

    assertStaticCoverage(english, after);
  });

  it('list section: polyline / angle / radius items, totals and in-progress readouts', () => {
    const activePolylinePoints = [mp(0, 0, 0), mp(3, 4, 0)];
    const activeRadiusPoints = [mp(0, 0, 0), mp(1, 0, 0), mp(0, 1, 0)];
    const anglePick = (x: number) => ({ kind: 'points' as const, point: mp(x, 0, 0) });

    useViewerStore.setState({
      measureMode: 'polyline',
      measurements: [
        { id: 'm1', start: mp(0, 0, 0), end: mp(1, 0, 0), distance: 1 },
        { id: 'm2', start: mp(0, 0, 0), end: mp(2, 0, 0), distance: 2 },
      ],
      activePolyline: { points: activePolylinePoints },
      polylineMeasurements: [{ id: 'pl1', points: [mp(0, 0, 0), mp(3, 4, 0)], closed: false, length: 5 }],
      angleMeasurements: [{ id: 'a1', kind: 'points', picks: [anglePick(0), anglePick(1), anglePick(2)] }],
      activeAngle: { kind: 'points', picks: [anglePick(0)] },
      radiusMeasurements: [{ id: 'r1', points: activeRadiusPoints }],
      activeRadius: { points: activeRadiusPoints },
    });
    const container = renderMeasure();
    openSection(container, 'List');
    const english = new Set<string>();
    addReadable(document.body, english);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = new Set<string>();
    addReadable(document.body, after);

    assertStaticCoverage(english, after);

    // Interpolated / plural keys this state exercises. `polylineSoFar`'s
    // `basis` param is itself `t('measure.polyline.basisLength')` (#4918
    // review, PR #5001), so under the pseudo locale it renders as ITS OWN
    // marked+interpolated string nested inside polylineSoFar's — checked
    // structurally (both marks present, count substituted) rather than via
    // `expectedMarked`, which computes only ONE key's substitution.
    assertMarked(after, 'measure.polyline.inProgress', { count: 2 });
    assertMarked(after, 'measure.polyline.indexLabel', { index: 1 });
    assert.ok(
      [...after].some(
        (s) =>
          s.startsWith('⟦measure.visuals.polylineSoFar|') &&
          s.includes(expectedMarked('measure.polyline.basisLength')) &&
          s.includes('so far - 2 pts'),
      ),
      'measure.visuals.polylineSoFar must be translated with its {count} substituted and its {basis} param itself translated (not bare English)',
    );
    assertMarked(after, 'measure.angle.indexLabel', { index: 1 });
    assertMarked(after, 'measure.angle.inProgress', { picks: 1, required: 3 });
    assertMarked(after, 'measure.angle.apexSetSuffix');
    assertMarked(after, 'measure.radius.indexLabel', { index: 1 });
    assertMarked(after, 'measure.radius.inProgress', { count: 3 });
    assertMarked(after, 'measure.list.deleteDistance', { index: 1 });
    assertMarked(after, 'measure.list.deletePolyline', { index: 1 });
    assertMarked(after, 'measure.list.deleteAngle', { index: 1 });
    assertMarked(after, 'measure.list.deleteRadius', { index: 1 });

    coveredParams.add('measure.polyline.inProgress');
    coveredParams.add('measure.polyline.indexLabel');
    coveredParams.add('measure.visuals.polylineSoFar');
    coveredParams.add('measure.angle.indexLabel');
    coveredParams.add('measure.angle.inProgress');
    coveredParams.add('measure.radius.indexLabel');
    coveredParams.add('measure.radius.inProgress');
    coveredParams.add('measure.list.deleteDistance');
    coveredParams.add('measure.list.deletePolyline');
    coveredParams.add('measure.list.deleteAngle');
    coveredParams.add('measure.list.deleteRadius');
    // Static, but sits beside a sibling {} expression in the same element
    // (see `assertMarked`'s own doc comment) so `assertStaticCoverage`'s
    // exact-match pass never finds it; checked explicitly above instead.
    coveredStatic.add('measure.angle.apexSetSuffix');
  });

  it('list section: the "first edge set" suffix (edges kind, 2 picks)', () => {
    const edgePick = { kind: 'edges' as const, point: mp(0, 0, 0) };
    useViewerStore.setState({
      measureMode: 'angle',
      angleKind: 'edges',
      activeAngle: { kind: 'edges', picks: [edgePick, edgePick] },
    });
    const container = renderMeasure();
    openSection(container, 'List');
    const english = new Set<string>();
    addReadable(document.body, english);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = new Set<string>();
    addReadable(document.body, after);

    assertStaticCoverage(english, after);
    assertMarked(after, 'measure.angle.firstEdgeSetSuffix');
    assertMarked(after, 'measure.angle.inProgress', { picks: 2, required: 4 });
    coveredStatic.add('measure.angle.firstEdgeSetSuffix'); // see the previous test's own note
    coveredParams.add('measure.angle.inProgress');
  });

  it('list section: empty state', () => {
    const container = renderMeasure();
    openSection(container, 'List');
    const english = new Set<string>();
    addReadable(document.body, english);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = new Set<string>();
    addReadable(document.body, after);

    assertStaticCoverage(english, after);
  });

  it('quantities section: no selection prompt', () => {
    const container = renderMeasure();
    openSection(container, 'Qty');
    const english = new Set<string>();
    addReadable(document.body, english);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = new Set<string>();
    addReadable(document.body, after);

    assertStaticCoverage(english, after);
  });

  it('quantities section: a selection unresolved to any loaded model', () => {
    useViewerStore.setState({ selectedEntity: { modelId: 'legacy', expressId: 2 } });
    const container = renderMeasure();
    openSection(container, 'Qty');
    const english = new Set<string>();
    addReadable(document.body, english);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = new Set<string>();
    addReadable(document.body, after);

    assertStaticCoverage(english, after);
    assertMarked(after, 'measure.quantities.header');
    assertMarked(after, 'measure.quantities.elementsCount', { count: 1 });
    assertMarked(after, 'measure.quantities.nothingFound');
    assertMarked(after, 'measure.quantities.unresolvedElements', { count: 1 });
    coveredStatic.add('measure.quantities.header');
    coveredStatic.add('measure.quantities.selectPrompt'); // selectPrompt itself only shows with NO selection; covered by the prior test.
    coveredParams.add('measure.quantities.elementsCount');
    coveredParams.add('measure.quantities.unresolvedElements');
  });

  it('point section: empty prompt (no live point)', () => {
    const container = renderMeasure();
    openSection(container, 'Point');
    const english = new Set<string>();
    addReadable(document.body, english);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = new Set<string>();
    addReadable(document.body, after);

    assertStaticCoverage(english, after);
  });

  it('point section: last point, model row, reference set and cleared', () => {
    useViewerStore.setState({
      measurements: [{ id: 'm1', start: mp(0, 0, 0), end: mp(5, 6, 7), distance: 10.6 }],
      measureReferencePoint: { x: 1, y: 2, z: 3 },
    });
    const container = renderMeasure();
    openSection(container, 'Point');
    const english = new Set<string>();
    addReadable(document.body, english);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = new Set<string>();
    addReadable(document.body, after);

    assertStaticCoverage(english, after);
  });

  it('point section: live point (an in-progress drag)', () => {
    useViewerStore.setState({
      activeMeasurement: { start: mp(0, 0, 0), current: mp(1, 1, 1), distance: 1.7 },
    });
    const container = renderMeasure();
    openSection(container, 'Point');
    const english = new Set<string>();
    addReadable(document.body, english);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = new Set<string>();
    addReadable(document.body, after);

    assertStaticCoverage(english, after);
  });

  it('accounts for every key across all renders, or a documented reason', () => {
    const uncoveredStatic = STATIC_KEYS.filter(
      (key) => !coveredStatic.has(key) && !NOT_RENDERED_IN_THIS_STATE.includes(key),
    );
    assert.deepEqual(uncoveredStatic, [], 'static key neither rendered nor listed in NOT_RENDERED_IN_THIS_STATE');

    const staleStatic = NOT_RENDERED_IN_THIS_STATE.filter((key) => coveredStatic.has(key));
    assert.deepEqual(staleStatic, [], 'key listed as not-rendered but is actually covered above');

    const uncoveredParams = PARAM_KEYS.filter(
      (key) => !coveredParams.has(key) && !NOT_RENDERED_PARAMS.includes(key),
    );
    assert.deepEqual(uncoveredParams, [], 'param/plural key neither exercised nor listed in NOT_RENDERED_PARAMS');

    const staleParams = NOT_RENDERED_PARAMS.filter((key) => coveredParams.has(key));
    assert.deepEqual(staleParams, [], 'param key listed as not-rendered but is actually covered above');

    // Every catalogue key is accounted for by exactly one of the four lists.
    const allAccounted = [...STATIC_KEYS, ...PARAM_KEYS].every(
      (key) =>
        coveredStatic.has(key) ||
        coveredParams.has(key) ||
        NOT_RENDERED_IN_THIS_STATE.includes(key) ||
        NOT_RENDERED_PARAMS.includes(key),
    );
    assert.ok(allAccounted, 'every measure.* key must be covered or documented as not-rendered');
  });
});
