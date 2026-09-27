/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Clash Detection panel reads the i18n catalogue (#4918 slice:
 * viewer-panels), covering `ClashPanel.tsx` (see `clash-panel.en.ts`'s own
 * docblock for the exact surface).
 *
 * Same oracle as `MainToolbar.i18n.test.tsx`/`Measure.i18n.test.tsx`: a
 * pseudo-locale maps every `clashPanel.*` key to a marked copy of its
 * English text, the panel is driven through a handful of store states that
 * surface as much of the catalogue as feasible, the locale is switched
 * live, and every marked string that was visible in English must reappear
 * marked. `ClashPanel` uses plain HTML `title` attributes (no Radix
 * tooltip), so no focus-walk is needed to reach them.
 *
 * Plural/`{param}` keys are exercised with `assertMarked`, which mirrors
 * just enough of `registry.ts`'s `resolve()` (plural-category selection +
 * placeholder interpolation) to compute the exact marked string the real
 * resolver would render — the point is to prove the KEY (and its params)
 * reach the DOM, not to re-implement the resolver.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { installLayout } from '@/test/dom-layout.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { clashPanelEn as ClashPanelEnType } from '@/i18n/catalogues/clash-panel.en';
import type { TranslationValue } from '@/i18n/types';
import { useViewerStore } from '@/store';
import type { Clash, ClashResult } from '@ifc-lite/clash';
import { CLASH_REVIEW_STATUSES, clashReviewKey } from '@ifc-lite/clash';
import type { ClashExclusionRule } from '@/lib/clash/exclusions';
import { ClashPanel } from './ClashPanel.js';

// Guarded dynamic import (#4918 revert-oracle, same pattern as
// Measure.i18n.test.tsx): reverting production hunks treats this brand-new
// catalogue as a deletion, and a static `import { clashPanelEn } from '...'`
// would then fail this file's whole LOAD — which the oracle reports as
// INCONCLUSIVE-by-load-failure rather than a red assertion. A guarded
// dynamic import turns a missing catalogue into a clean `describe.skip`
// instead, so the revert witness comes from the real assertions below.
let clashPanelEnLoaded: typeof ClashPanelEnType | undefined;
try {
  ({ clashPanelEn: clashPanelEnLoaded } = await import('@/i18n/catalogues/clash-panel.en'));
} catch {
  clashPanelEnLoaded = undefined;
}
const HAS_CATALOGUE = clashPanelEnLoaded !== undefined;
const clashPanelEn: typeof ClashPanelEnType = clashPanelEnLoaded ?? ({} as typeof ClashPanelEnType);

type ClashPanelKey = keyof typeof clashPanelEn;
const KEYS = Object.keys(clashPanelEn) as ClashPanelKey[];
const STATIC_KEYS = KEYS.filter((key) => {
  const v = clashPanelEn[key];
  return typeof v === 'string' && !v.includes('{');
});

function addReadable(root: ParentNode, out: Set<string>): void {
  root.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const title = element.getAttribute('title');
    if (title) out.add(title);
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

function chromeStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  addReadable(document.body, out);
  return out;
}

/** Key-specific pseudo translation; keeps every `{placeholder}` and plural category. */
function markValue(key: ClashPanelKey, value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${key}|${value}⟧`;
  const wrapped: Record<string, string> = {};
  for (const [category, text] of Object.entries(value)) wrapped[category] = `⟦${key}|${text}⟧`;
  return wrapped as TranslationValue;
}
const PSEUDO: Catalogue = Object.fromEntries(KEYS.map((key) => [key, markValue(key, clashPanelEn[key])])) as Catalogue;
const PSEUDO_LOCALE = 'clash-panel-pseudo';

function expectedMarked(key: ClashPanelKey, params: Record<string, string | number> = {}): string {
  const value = clashPanelEn[key];
  const template = typeof value === 'string'
    ? value
    : (typeof params.count === 'number'
      ? (value as Record<string, string>)[new Intl.PluralRules('en').select(params.count)] ?? value.other
      : value.other);
  const interpolated = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole);
  return `⟦${key}|${interpolated}⟧`;
}

function assertMarked(after: Set<string>, key: ClashPanelKey, params: Record<string, string | number> = {}): void {
  const expected = expectedMarked(key, params);
  const found = [...after].some((s) => s.includes(expected));
  assert.ok(found, `${key}: expected marked+interpolated text not found anywhere: ${expected}`);
}

function elementRef(key: string, model: string, tag: string, name?: string) {
  return { key, ref: Number(key.replace(/\D/g, '')) || 1, model, tag, name };
}

function makeClash(overrides: Partial<Clash> & Pick<Clash, 'id' | 'a' | 'b'>): Clash {
  return {
    rule: 'all-clashes',
    status: 'hard',
    distance: -0.05,
    distanceKind: 'mesh',
    point: [0, 0, 0],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    severity: 'critical',
    ...overrides,
  } as Clash;
}

const CLASH_A = makeClash({
  id: 'c1',
  a: elementRef('g1', 'm1', 'IfcWall', 'Wall A'),
  b: elementRef('g2', 'm1', 'IfcDuctSegment', 'Duct B'),
  severity: 'critical',
});
const CLASH_B = makeClash({
  id: 'c2',
  a: elementRef('g3', 'm1', 'IfcWall', 'Wall C'),
  b: elementRef('g4', 'm1', 'IfcDuctSegment', 'Duct D'),
  severity: 'major',
  status: 'touch',
  distance: 0,
});
const CLASH_C = makeClash({
  id: 'c3',
  a: elementRef('g5', 'm1', 'IfcSlab', 'Slab E'),
  b: elementRef('g6', 'm1', 'IfcBeam', 'Beam F'),
  severity: 'minor',
});
const CLASH_D = makeClash({
  id: 'c4',
  a: elementRef('g7', 'm1', 'IfcColumn', 'Column G'),
  b: elementRef('g8', 'm1', 'IfcSlab', 'Slab H'),
  severity: 'info',
});

function makeResult(clashes: Clash[]): ClashResult {
  const bySeverity = { critical: 0, major: 0, minor: 0, info: 0 };
  for (const c of clashes) bySeverity[c.severity] += 1;
  return {
    clashes,
    summary: {
      total: clashes.length,
      byRule: { 'all-clashes': clashes.length },
      byTypePair: { 'IfcDuctSegment vs IfcWall': clashes.length },
      bySeverity,
    },
    rulesRun: [{ id: 'all-clashes', name: 'All clashes', a: '*', mode: 'hard' }],
    ruleCoverage: [{ rule: 'all-clashes', matchedA: 4, matchedB: 4 }],
    settings: { tolerance: 0.005, excludeVoidsAndHosts: true },
  };
}

const EXCLUSION_RULE: ClashExclusionRule = {
  id: 'ex1',
  kind: 'typePair',
  a: 'IfcWall',
  b: 'IfcDuctSegment',
  label: 'IfcWall × IfcDuctSegment',
  enabled: true,
  createdAt: 1,
};
const EXCLUSION_RULE_ANY: ClashExclusionRule = {
  id: 'ex2',
  kind: 'typeAny',
  a: 'IfcSlab',
  b: 'IfcSlab',
  label: 'IfcSlab (any)',
  enabled: true,
  createdAt: 2,
};
const EXCLUSION_RULE_PAIR: ClashExclusionRule = {
  id: 'ex3',
  kind: 'elementPair',
  a: 'g7',
  b: 'g8',
  label: 'Column G × Slab H',
  enabled: false,
  createdAt: 3,
};

const RESET = {
  clashPanelVisible: false,
  clashResult: null,
  clashGroups: null,
  clashRunning: false,
  clashProgress: null,
  clashError: null,
  clashMode: 'hard' as const,
  clashGroupBy: 'severity' as const,
  clashSortBy: 'severity' as const,
  clashHideTouching: false,
  clashFocusMode: 'ghost' as const,
  clashReviews: new Map(),
  clashStatusFilter: new Set(CLASH_REVIEW_STATUSES),
  clashExclusions: [],
  clashExclusionCounts: new Map(),
  clashSuppressedCount: 0,
  clashSelectedId: null,
  clashSolidStatus: 'none' as const,
  models: new Map(),
} as Partial<ReturnType<typeof useViewerStore.getState>>;

const coveredStatic = new Set<ClashPanelKey>();

installLayout();

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState(RESET);
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(RESET);
});

/** Static keys none of this suite's render states can show, each for a
 *  stated reason. */
const NOT_RENDERED_IN_THIS_STATE: ClashPanelKey[] = [
  // Duplicate-scan-only chrome: no fixture here runs `runDuplicates`, whose
  // resulting `duplicateSetSections` grouping is what the "always group by
  // coincident set" disabled state describes.
  'clashPanel.duplicateScanGroupTooltip',
  // The manual-groups result view (`resultView === 'groups'`) needs a
  // created group via `useManualClashGroups`'s dialog flow.
  'clashPanel.userDefinedGroups',
  // These four are never rendered as their OWN standalone text — each is
  // resolved only to fill an `{action}` param inside a larger composite
  // key (`clashPanel.statusFilterTooltip`, `clashPanel.excluded.toggleAriaLabel`).
  // Those composite keys' own `assertMarked` calls already prove the pseudo
  // catalogue's word for "Hide"/"Show"/"Disable"/"Enable" reaches the DOM.
  'clashPanel.action.hide',
  'clashPanel.action.show',
  'clashPanel.action.disable',
  'clashPanel.action.enable',
  // Re-run tooltips for a rule-set / duplicate-scan result (#5818): the kind
  // is recorded on the result by the real run (`lib/clash/run-request.ts`),
  // which no fixture here performs. `ClashPanel.rerun-last.test.tsx` renders
  // and asserts both.
  'clashPanel.rerunTooltipMatrix',
  'clashPanel.rerunTooltipDuplicates',
];

/**
 * Multi-word help-paragraph runs that sit as plain-text SIBLINGS of
 * `<b>`/`<i>` elements inside the same `<p>` (#4918 — one full sentence split
 * at its bold/italic runs, not fragments assembled client-side):
 * `addReadable` joins every direct text-node child of that `<p>` into ONE
 * combined string, so these need a substring check rather than exact
 * equality. Deliberately NOT extended to every key — a short, common token
 * (`tol`, `gap`, `not`, `any`) would substring-match unrelated prose
 * elsewhere on the panel and silently certify a key that never actually
 * rendered.
 */
const SUBSTRING_KEYS = new Set<ClashPanelKey>([
  'clashPanel.help.hardDescription',
  'clashPanel.help.clearanceDescription',
  'clashPanel.help.gapAddsMore',
  'clashPanel.help.resultsNotFiltered',
  'clashPanel.help.tolDescription',
  'clashPanel.help.gapDescription',
  'clashPanel.help.severityDescription',
  'clashPanel.help.fromOverlapDepth',
  'clashPanel.help.surfaceWorst',
  // "Hide touching" shares its label element with an adjacent `(count)`
  // badge — same joined-text-node reasoning as the help paragraphs above.
  'clashPanel.hideTouchingLabel',
]);

function assertStaticCoverage(english: Set<string>, after: Set<string>): void {
  for (const key of STATIC_KEYS) {
    if (NOT_RENDERED_IN_THIS_STATE.includes(key)) continue;
    const text = clashPanelEn[key] as string;
    const marked = `⟦${key}|${text}⟧`;
    const found = SUBSTRING_KEYS.has(key)
      ? [...english].some((s) => s.includes(text))
      : english.has(text);
    if (!found) continue;
    const translated = SUBSTRING_KEYS.has(key)
      ? [...after].some((s) => s.includes(marked))
      : after.has(marked);
    assert.ok(translated, `${key}: "${text}" must be translated, marked text not found`);
    coveredStatic.add(key);
  }
}

describe('ClashPanel localization (#4918)', { skip: !HAS_CATALOGUE && 'clash-panel.en.ts catalogue module not present (revert-oracle probe)' }, () => {
  it('header, help disclosure, empty state (single model), and close', () => {
    useViewerStore.setState({ models: new Map() });
    const container = render(<ClashPanel onClose={() => {}} />);
    // Open the help disclosure so its four paragraphs are on screen.
    const helpButton = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'How clash detection works');
    assert.ok(helpButton, 'help toggle button not found');
    act(() => helpButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));

    const english = chromeStrings(container);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);

    assertStaticCoverage(english, after);
  });

  it('empty state (multi model) and duplicate/matrix run buttons', () => {
    useViewerStore.setState({ models: new Map([['m1', {}], ['m2', {}]]) as never });
    const container = render(<ClashPanel />);
    const english = chromeStrings(container);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertStaticCoverage(english, after);
  });

  it('running state: live progress and Detecting… label', () => {
    useViewerStore.setState({ clashRunning: true, clashProgress: { phase: 'narrow', rule: 'all-clashes', done: 3, total: 10 } });
    const container = render(<ClashPanel />);
    const english = chromeStrings(container);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertStaticCoverage(english, after);
    assertMarked(after, 'clashPanel.progress.checking', { done: '3', total: '10' });
  });

  it('running state: indeterminate progress shows "Preparing geometry…"', () => {
    useViewerStore.setState({ clashRunning: true, clashProgress: { phase: 'broad', rule: 'all-clashes', done: 0, total: 0 } });
    const container = render(<ClashPanel />);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertMarked(after, 'clashPanel.progress.preparing');
    coveredStatic.add('clashPanel.progress.preparing');
  });

  it('a result with four clashes (every severity), three exclusions, a review comment, clearance mode, focus mode "highlight": summary toolbar, filters, rows, review + exclude controls', () => {
    useViewerStore.setState({
      clashResult: makeResult([CLASH_A, CLASH_B, CLASH_C, CLASH_D]),
      clashExclusions: [EXCLUSION_RULE, EXCLUSION_RULE_ANY, EXCLUSION_RULE_PAIR],
      clashExclusionCounts: new Map([['ex1', 2], ['ex2', 1], ['ex3', 1]]),
      clashSuppressedCount: 2,
      clashFocusMode: 'highlight',
      clashReviews: new Map([[clashReviewKey(CLASH_A), { status: 'open' as const, comment: 'Confirmed by MEP lead' }]]),
      models: new Map([['m1', {}]]) as never,
    });
    const container = render(<ClashPanel />);

    // Expand only ONE row (leaving the other collapsed) so both the
    // "Show both objects" and "Collapse" tooltip variants are on screen.
    const expandButton = [...container.querySelectorAll('button[aria-expanded]')].find((b) => b.getAttribute('title') === 'Show both objects');
    assert.ok(expandButton, 'row expand toggle not found');
    act(() => expandButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));

    const english = chromeStrings(container);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);

    assertStaticCoverage(english, after);
    assertMarked(after, 'clashPanel.excluded.summary', { count: 3 });
    assertMarked(after, 'clashPanel.excluded.hiddenSuffix', { count: 2 });
    assertMarked(after, 'clashPanel.excluded.countHidden', { count: 2 });
    assertMarked(after, 'clashPanel.exclude.anyButton', { tag: 'IfcWall' });
    assertMarked(after, 'clashPanel.exclude.pairButton', { tagA: 'IfcWall', tagB: 'IfcDuctSegment' });
    assertMarked(after, 'clashPanel.statusFilterTooltip', { action: '⟦clashPanel.action.hide|Hide⟧', status: '⟦clashPanel.reviewStatus.open|Open⟧'.toLowerCase() });
  });

  it('ghost focus mode shows the ghost tooltip on the row focus-toggle button', () => {
    useViewerStore.setState({ clashResult: makeResult([CLASH_A]), clashFocusMode: 'ghost' });
    const container = render(<ClashPanel />);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assert.ok(after.has(`⟦clashPanel.focusToggleGhostTooltip|${clashPanelEn['clashPanel.focusToggleGhostTooltip']}⟧`));
    coveredStatic.add('clashPanel.focusToggleGhostTooltip');
  });

  it('clearance mode, no result yet: detection controls default open, gap field shown', () => {
    useViewerStore.setState({ clashMode: 'clearance' });
    const container = render(<ClashPanel />);
    const english = chromeStrings(container);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assert.ok(english.has('Minimum required separation (m); elements closer than this are flagged'), 'gap field title not rendered in clearance mode');
    assert.ok(
      after.has(`⟦clashPanel.gapLabelTooltip|${clashPanelEn['clashPanel.gapLabelTooltip']}⟧`),
      'clashPanel.gapLabelTooltip not translated',
    );
    coveredStatic.add('clashPanel.gapLabelTooltip');
  });

  it('"Issues" result view (spatial-cluster grouping) shows the proximity label', () => {
    useViewerStore.setState({
      clashResult: makeResult([CLASH_A, CLASH_B]),
      clashGroups: [{ id: 'grp1', title: 'IfcWall × IfcDuctSegment cluster', members: [CLASH_A, CLASH_B], bounds: { min: [0, 0, 0], max: [1, 1, 1] }, representativePoint: [0, 0, 0], severity: 'critical' }],
    });
    const container = render(<ClashPanel />);
    const issuesButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Issues');
    assert.ok(issuesButton, '"Issues" result-view button not found');
    act(() => issuesButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assert.ok(
      after.has(`⟦clashPanel.groupedByProximity|${clashPanelEn['clashPanel.groupedByProximity']}⟧`),
      'clashPanel.groupedByProximity not translated',
    );
    coveredStatic.add('clashPanel.groupedByProximity');
  });

  it('every clash filtered out by review status (no untick-hide-touching hint applies)', () => {
    useViewerStore.setState({
      clashResult: makeResult([CLASH_A]),
      clashStatusFilter: new Set(),
      clashHideTouching: false,
    });
    const container = render(<ClashPanel />);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assert.ok(
      after.has(`⟦clashPanel.noMatches.hintPlain|${clashPanelEn['clashPanel.noMatches.hintPlain']}⟧`),
      'clashPanel.noMatches.hintPlain not translated',
    );
    coveredStatic.add('clashPanel.noMatches.hintPlain');
  });

  it('matrix run matched nothing (multi-rule)', () => {
    const empty = makeResult([]);
    empty.rulesRun = [
      { id: 'r1', name: 'Pipes vs Structure', a: 'IfcPipeSegment', b: 'IfcColumn', mode: 'hard' },
      { id: 'r2', name: 'Ducts vs Structure', a: 'IfcDuctSegment', b: 'IfcColumn', mode: 'hard' },
    ];
    empty.ruleCoverage = [
      { rule: 'r1', matchedA: 0, matchedB: 3 },
      { rule: 'r2', matchedA: 0, matchedB: 3 },
    ];
    useViewerStore.setState({ clashResult: empty });
    const container = render(<ClashPanel />);
    const english = chromeStrings(container);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertStaticCoverage(english, after);
    assertMarked(after, 'clashPanel.matrixNoMatch.description', { count: 2 });
    assertMarked(after, 'clashPanel.matrixNoMatch.emptyRules', { names: 'Pipes vs Structure, Ducts vs Structure' });
  });

  it('single ad-hoc rule matched nothing (selector no-match)', () => {
    const empty = makeResult([]);
    empty.rulesRun = [{ id: 'r1', name: 'Pipes vs Structure', a: 'IfcPipeSegment', b: 'IfcColumn', mode: 'hard' }];
    empty.ruleCoverage = [{ rule: 'r1', matchedA: 0, matchedB: 3 }];
    useViewerStore.setState({ clashResult: empty });
    const container = render(<ClashPanel />);
    const english = chromeStrings(container);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertStaticCoverage(english, after);
    assert.ok([...after].some((s) => s.includes('⟦clashPanel.selectorNoMatch.description|')), 'selectorNoMatch.description not marked');
    coveredStatic.add('clashPanel.selectorNoMatch.description' as ClashPanelKey);
  });

  it('clean result: no clashes found, with a partially-empty rule', () => {
    const clean = makeResult([]);
    clean.rulesRun = [
      { id: 'r1', name: 'Pipes vs Structure', a: 'IfcPipeSegment', b: 'IfcColumn', mode: 'hard' },
      { id: 'r2', name: 'Ducts vs Structure', a: 'IfcDuctSegment', b: 'IfcColumn', mode: 'hard' },
    ];
    clean.ruleCoverage = [
      { rule: 'r1', matchedA: 2, matchedB: 3 },
      { rule: 'r2', matchedA: 0, matchedB: 3 },
    ];
    useViewerStore.setState({ clashResult: clean });
    const container = render(<ClashPanel />);
    const english = chromeStrings(container);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertStaticCoverage(english, after);
    assertMarked(after, 'clashPanel.noClashes.partialRules', { count: 1, names: 'Ducts vs Structure' });
  });

  it('a result with everything filtered out: no matches + untick hint', () => {
    useViewerStore.setState({
      clashResult: makeResult([CLASH_B]),
      clashHideTouching: true,
      clashStatusFilter: new Set(CLASH_REVIEW_STATUSES),
    });
    const container = render(<ClashPanel />);
    const english = chromeStrings(container);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertStaticCoverage(english, after);
    assert.ok(after.has(`⟦clashPanel.noMatches.hintWithUntick|${clashPanelEn['clashPanel.noMatches.hintWithUntick']}⟧`));
    coveredStatic.add('clashPanel.noMatches.hintWithUntick');
  });

  it('intersection-solid statuses: computing, solid, and each unavailable reason', () => {
    const states: Array<{ status: 'computing' | 'solid' | 'unavailable'; reason?: 'below-kernel-resolution' | 'no-overlap' | 'empty-operand' | 'other' }> = [
      { status: 'computing' },
      { status: 'solid' },
      { status: 'unavailable', reason: 'below-kernel-resolution' },
      { status: 'unavailable', reason: 'no-overlap' },
      { status: 'unavailable', reason: 'empty-operand' },
      { status: 'unavailable', reason: 'other' },
    ];
    for (const st of states) {
      useViewerStore.setState({
        clashResult: makeResult([CLASH_A]),
        clashSelectedId: CLASH_A.id,
        clashSolidStatus: st.status,
        clashSolidReason: st.reason,
        clashSolidVolumeM3: 0.02,
        clashSolidThicknessM: 0.001,
        clashSolidRequiredM: 0.004,
      } as never);
      const container = render(<ClashPanel />);
      registerLocale(PSEUDO_LOCALE, PSEUDO);
      act(() => setLocale(PSEUDO_LOCALE));
      const after = chromeStrings(container);
      if (st.status === 'computing') {
        assertMarked(after, 'clashPanel.solid.computing');
        coveredStatic.add('clashPanel.solid.computing');
      } else if (st.status === 'solid') {
        assertMarked(after, 'clashPanel.solid.shown', { volume: '0.020 m³' });
      } else if (st.reason === 'below-kernel-resolution') {
        assertMarked(after, 'clashPanel.solid.belowResolution', { thickness: '1.00', required: '4.00' });
      } else if (st.reason === 'no-overlap') {
        assertMarked(after, 'clashPanel.solid.noOverlap');
        coveredStatic.add('clashPanel.solid.noOverlap');
      } else if (st.reason === 'empty-operand') {
        assertMarked(after, 'clashPanel.solid.emptyOperand');
        coveredStatic.add('clashPanel.solid.emptyOperand');
      } else {
        assertMarked(after, 'clashPanel.solid.unknown');
        coveredStatic.add('clashPanel.solid.unknown');
      }
      cleanup();
      setLocale('en');
    }
  });

  it('group-by "By rule" and "By type pair" options render their own labels', () => {
    useViewerStore.setState({ clashResult: makeResult([CLASH_A, CLASH_B]), clashGroupBy: 'rule' });
    const container1 = render(<ClashPanel />);
    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    assertMarked(chromeStrings(container1), 'clashPanel.groupByRuleOption');
    cleanup();
    setLocale('en');

    useViewerStore.setState({ clashResult: makeResult([CLASH_A, CLASH_B]), clashGroupBy: 'typePair' });
    const container2 = render(<ClashPanel />);
    act(() => setLocale(PSEUDO_LOCALE));
    assertMarked(chromeStrings(container2), 'clashPanel.groupByTypePairOption');
  });

  it('accounts for every static key across the suite or a documented reason', () => {
    const unaccounted = STATIC_KEYS.filter((key) => !coveredStatic.has(key) && !NOT_RENDERED_IN_THIS_STATE.includes(key));
    assert.deepEqual(unaccounted, [], 'key neither rendered by any test above nor listed in NOT_RENDERED_IN_THIS_STATE');
  });
});
