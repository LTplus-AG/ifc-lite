/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Lens panel reads the i18n catalogue (#4918 slice: viewer-panels),
 * covering `LensPanel.tsx` (see `lens-panel.en.ts`'s own docblock for the
 * exact surface).
 *
 * Same oracle shape as `ClashPanel.i18n.test.tsx`/`Measure.i18n.test.tsx`: a
 * pseudo-locale maps a `lensPanel.*` key to a marked copy of its English
 * text, the panel (or an exported sub-component, for states the top-level
 * panel cannot reach directly — `RuleEditor`/`AutoColorEditor` are exported
 * for exactly this) is driven through the states that surface as much of
 * the catalogue as feasible, the locale is switched live, and every marked
 * string that was visible in English must reappear marked. `LensPanel` uses
 * plain HTML `title`/`aria-label` attributes (no Radix tooltip), so no
 * focus-walk is needed to reach them.
 *
 * Deliberately NOT a dynamic import of `lens-panel.en.ts` gating a
 * `describe.skip` (the pattern `ClashPanel.i18n.test.tsx` uses): reverting
 * this PR's production hunks deletes that brand-new catalogue file
 * entirely, so a skip-when-missing guard would skip the WHOLE suite on
 * revert — the revert oracle then sees zero tests collected and reports
 * INCONCLUSIVE rather than the RED it needs to call this OBSERVED. Instead,
 * the expected English strings are a plain literal mirror
 * (`LENS_PANEL_EN` below) that has no import dependency on the production
 * catalogue at all: reverting `LensPanel.tsx` back to hardcoded JSX text
 * still lets this file load and run, and the pseudo-locale assertions then
 * fail for real (the reverted component never calls `t()`, so nothing gets
 * marked). The one place this file DOES read the real catalogue
 * (`catalogueStaysInSync` below) is wrapped so a missing module degrades to
 * a no-op rather than blocking the rest of the suite.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue } from '@/i18n/types';
import { useViewerStore } from '@/store';
import type { Lens, LensRule, AutoColorLegendEntry } from '@/store/slices/lensSlice';
import { LensPanel, AutoColorEditor } from './LensPanel.js';
import { LensRuleEditor } from './LensRuleEditor.js';

/**
 * Literal mirror of `lens-panel.en.ts` — deliberately NOT imported from the
 * production catalogue (see the file docblock above for why). Kept in sync
 * by `catalogueStaysInSync` below whenever the real module is importable.
 */
const LENS_PANEL_EN = {
  'lensPanel.title': 'Lens',
  'lensPanel.exportTooltip': 'Export lenses as JSON',
  'lensPanel.importTooltip': 'Import lenses from JSON',
  'lensPanel.clearButton': 'Clear',
  'lensPanel.closeAriaLabel': 'Close',
  'lensPanel.newRuleLensButton': 'New Rule Lens',
  'lensPanel.newAutoColorLensButton': 'New Auto-Color Lens',
  'lensPanel.emptyTitle': 'No lenses yet',
  'lensPanel.emptyDescription': 'Create a lens to color or focus model elements.',
  'lensPanel.footer.active': 'Active · {colored} colored · {hidden}',
  'lensPanel.footer.hiddenCount': { one: '{count} hidden', other: '{count} hidden' },
  'lensPanel.footer.ghosted': 'ghosted',
  'lensPanel.footer.clickToActivate': 'Click a lens to activate',
  'lensPanel.type.ifcType': 'IFC Class',
  'lensPanel.type.attribute': 'Attribute',
  'lensPanel.type.property': 'Property',
  'lensPanel.type.quantity': 'Quantity',
  'lensPanel.type.classification': 'Classification',
  'lensPanel.type.material': 'Material',
  'lensPanel.type.model': 'Model',
  'lensPanel.type.group': 'Zone / Group',
  'lensPanel.ruleRow.isolateTooltip': 'Click to isolate / show only this group',
  'lensPanel.ruleRow.emptyTooltip': 'No matching entities',
  'lensPanel.isolatedBadge': 'isolated',
  'lensPanel.autoColorRow.isolateTooltip': 'Click to isolate / show only this value',
  'lensPanel.ruleEditor.reorderAriaLabel': 'Reorder rule: drag, or press arrow up or down',
  'lensPanel.ruleEditor.reorderTooltip': 'Drag to reorder (or arrow keys)',
  'lensPanel.ruleEditor.compoundTypeAriaLabel': 'Compound criteria type (read-only, imported)',
  'lensPanel.ruleEditor.criteriaTypeAriaLabel': 'Criteria type',
  'lensPanel.ruleEditor.compoundReadOnlyTooltip':
    'Compound rules are imported read-only; this panel does not yet support editing them.',
  'lensPanel.ruleEditor.classPlaceholder': 'Class...',
  'lensPanel.ruleEditor.attributeValuePlaceholder': 'value...',
  'lensPanel.ruleEditor.materialPlaceholder': 'Material...',
  'lensPanel.ruleEditor.noModelsLoaded': 'No models loaded',
  'lensPanel.ruleEditor.modelFallbackLabel': 'Model',
  'lensPanel.ruleEditor.modelSelectPlaceholder': 'Model...',
  'lensPanel.ruleEditor.groupPlaceholder': 'Zone / group name (blank = any)',
  'lensPanel.ruleEditor.duplicateTooltip': 'Duplicate rule',
  'lensPanel.ruleEditor.removeTooltip': 'Remove rule',
  'lensPanel.ruleEditor.propertySetPlaceholder': 'Property set...',
  'lensPanel.ruleEditor.propertyNamePlaceholder': 'Property...',
  'lensPanel.ruleEditor.quantitySetPlaceholder': 'Quantity set...',
  'lensPanel.ruleEditor.quantityNamePlaceholder': 'Quantity...',
  'lensPanel.ruleEditor.classificationSystemPlaceholder': 'System...',
  'lensPanel.ruleEditor.classificationCodePlaceholder': 'Code...',
  'lensPanel.ruleEditor.valuePlaceholder': 'Value...',
  'lensPanel.action.colorize': 'Color',
  'lensPanel.action.transparent': 'Transp',
  'lensPanel.action.hide': 'Hide',
  'lensPanel.editor.namePlaceholder': 'Lens name...',
  'lensPanel.editor.addRule': 'Add Rule',
  'lensPanel.editor.save': 'Save',
  'lensPanel.editor.cancel': 'Cancel',
  'lensPanel.autoColor.namePlaceholder': 'Auto-color lens name...',
  'lensPanel.autoColor.byDistinctValues': 'Auto-color by distinct values',
  'lensPanel.autoColor.sourceLabel': 'Source',
  'lensPanel.autoColor.psetLabel': 'Pset',
  'lensPanel.autoColor.systemLabel': 'System',
  'lensPanel.autoColor.qsetLabel': 'Qset',
  'lensPanel.autoColor.selectPropertySetPlaceholder': 'Select property set...',
  'lensPanel.autoColor.selectSystemPlaceholder': 'Select system...',
  'lensPanel.autoColor.selectQuantitySetPlaceholder': 'Select quantity set...',
  'lensPanel.autoColor.nameLabel': 'Name',
  'lensPanel.autoColor.selectPlaceholderOption': 'Select...',
  'lensPanel.autoColor.selectPropertyPlaceholder': 'Select property...',
  'lensPanel.autoColor.selectQuantityPlaceholder': 'Select quantity...',
  'lensPanel.autoColor.showUnclassified': 'Show unclassified',
  'lensPanel.card.sortCount': 'Count',
  'lensPanel.card.sortNameAsc': 'A→Z',
  'lensPanel.card.sortNameDesc': 'Z→A',
  'lensPanel.card.duplicateBuiltinTooltip': 'Duplicate into an editable copy',
  'lensPanel.card.duplicateTooltip': 'Duplicate lens',
  'lensPanel.card.editTooltip': 'Edit lens',
  'lensPanel.card.deleteTooltip': 'Delete lens',
  'lensPanel.card.ruleCount': { one: '{count} rule', other: '{count} rules' },
  'lensPanel.card.legendValuesCount': { one: '{count} value', other: '{count} values' },
  'lensPanel.card.sortLegendTooltip': 'Sort legend entries',
} as const;

type LensPanelKey = keyof typeof LENS_PANEL_EN;
const KEYS = Object.keys(LENS_PANEL_EN) as LensPanelKey[];
const lensPanelEn = LENS_PANEL_EN;

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
  addReadable(container, out);
  return out;
}

/** Key-specific pseudo translation; keeps every `{placeholder}` and plural category. */
function markValue(key: LensPanelKey, value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${key}|${value}⟧`;
  const wrapped: Record<string, string> = {};
  for (const [category, text] of Object.entries(value)) wrapped[category] = `⟦${key}|${text}⟧`;
  return wrapped as TranslationValue;
}
const SHARED_OPERATOR_EN = {
  'filterOperators.isSet': 'is set',
  'filterOperators.eq': '=',
  'filterOperators.contains': 'contains',
  'filterOperators.ne': '≠',
  'filterOperators.gt': '>',
  'filterOperators.gte': '≥',
  'filterOperators.lt': '<',
  'filterOperators.lte': '≤',
} as const;
const PSEUDO: Catalogue = {
  ...Object.fromEntries(KEYS.map((key) => [key, markValue(key, lensPanelEn[key])])),
  ...Object.fromEntries(Object.entries(SHARED_OPERATOR_EN).map(([key, value]) => [key, `⟦${key}|${value}⟧`])),
} as Catalogue;
const PSEUDO_LOCALE = 'lens-panel-pseudo';

function expectedMarked(key: LensPanelKey, params: Record<string, string | number> = {}): string {
  const value = lensPanelEn[key];
  const template = typeof value === 'string'
    ? value
    : (typeof params.count === 'number'
      ? (value as Record<string, string>)[new Intl.PluralRules('en').select(params.count)] ?? value.other
      : value.other);
  const interpolated = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole);
  return `⟦${key}|${interpolated}⟧`;
}

function assertMarked(after: Set<string>, key: LensPanelKey, params: Record<string, string | number> = {}): void {
  const expected = expectedMarked(key, params);
  const found = [...after].some((s) => s.includes(expected));
  assert.ok(found, `${key}: expected marked+interpolated text not found anywhere: ${expected}`);
}

const noop = () => {};

function ifcRule(overrides: Partial<LensRule> = {}): LensRule {
  return {
    id: 'rule-ifc',
    name: 'Walls',
    enabled: true,
    groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] }],
    action: 'colorize',
    color: '#e53935',
    ...overrides,
  };
}

function ruleLens(rules: LensRule[]): Lens {
  return { id: 'lens-rules', name: 'My Rule Lens', rules };
}

function autoColorLens(): Lens {
  return {
    id: 'lens-auto',
    name: 'Color by Material',
    rules: [],
    autoColor: { source: 'material' },
  };
}

const AUTOCOLOR_LEGEND: AutoColorLegendEntry[] = [
  { id: 'v1', name: 'Concrete', color: '#e53935', count: 12 },
  { id: 'v2', name: 'Steel', color: '#1e88e5', count: 3 },
];

const RESET = {
  savedLenses: [] as Lens[],
  activeLensId: null,
  lensColorMap: new Map(),
  lensHiddenIds: new Set<number>(),
  lensRuleIsolation: null,
  lensRuleCounts: new Map(),
  lensAutoColorLegend: [] as AutoColorLegendEntry[],
  discoveredLensData: null,
  models: new Map(),
} as Partial<ReturnType<typeof useViewerStore.getState>>;

beforeEach(() => {
  setLocale('en');
  useViewerStore.setState(RESET);
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState(RESET);
});

describe('Lens panel localization (#4918)', () => {
  it('the literal LENS_PANEL_EN mirror stays in sync with lens-panel.en.ts, when that module is importable', async () => {
    // Best-effort only (#4918 revert-oracle): once production is reverted,
    // the catalogue file this imports no longer exists, and a load failure
    // here must not block the rest of the suite (see the file docblock).
    let real: Record<string, TranslationValue> | undefined;
    try {
      ({ lensPanelEn: real } = await import('@/i18n/catalogues/lens-panel.en'));
    } catch {
      real = undefined;
    }
    if (!real) return;
    assert.deepEqual(real, LENS_PANEL_EN, 'LENS_PANEL_EN in this test file has drifted from lens-panel.en.ts — update the mirror above');
  });

  it('empty panel: header, new-lens buttons, "click a lens to activate" footer, close', () => {
    const container = render(<LensPanel onClose={() => {}} />);
    const english = chromeStrings(container);
    for (const key of [
      'lensPanel.title', 'lensPanel.exportTooltip', 'lensPanel.importTooltip',
      'lensPanel.closeAriaLabel', 'lensPanel.newRuleLensButton', 'lensPanel.newAutoColorLensButton',
      'lensPanel.emptyTitle', 'lensPanel.emptyDescription',
      'lensPanel.footer.clickToActivate',
    ] as LensPanelKey[]) {
      assert.ok(english.has(lensPanelEn[key] as string), `expected "${lensPanelEn[key]}" (${key}) visible before switching locale`);
    }

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    for (const key of [
      'lensPanel.title', 'lensPanel.exportTooltip', 'lensPanel.importTooltip',
      'lensPanel.closeAriaLabel', 'lensPanel.newRuleLensButton', 'lensPanel.newAutoColorLensButton',
      'lensPanel.emptyTitle', 'lensPanel.emptyDescription',
      'lensPanel.footer.clickToActivate',
    ] as LensPanelKey[]) {
      assertMarked(after, key);
    }
  });

  it('footer status: active lens with hidden ids interpolates colored + hidden counts', () => {
    useViewerStore.setState({
      savedLenses: [ruleLens([ifcRule()])],
      activeLensId: 'lens-rules',
      lensColorMap: new Map([[1, '#e53935']]),
      lensHiddenIds: new Set([1, 2]),
    });
    const container = render(<LensPanel />);
    const english = chromeStrings(container);
    assert.ok([...english].some((s) => s.includes('1 colored') && s.includes('2 hidden')), 'expected the active footer to interpolate colored+hidden counts');

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertMarked(after, 'lensPanel.footer.hiddenCount', { count: 2 });
    assertMarked(after, 'lensPanel.footer.active', { colored: 1, hidden: expectedMarked('lensPanel.footer.hiddenCount', { count: 2 }) });
  });

  it('footer status: active lens with nothing hidden shows "ghosted"', () => {
    useViewerStore.setState({
      savedLenses: [ruleLens([ifcRule()])],
      activeLensId: 'lens-rules',
      lensColorMap: new Map([[1, '#e53935']]),
      lensHiddenIds: new Set(),
    });
    const container = render(<LensPanel />);
    const english = chromeStrings(container);
    assert.ok([...english].some((s) => s.includes('ghosted')));

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertMarked(after, 'lensPanel.footer.ghosted');
  });

  it('rule-based lens card: active with two rules (one empty), isolate tooltip, isolated badge, rule count', () => {
    const rules = [
      ifcRule({ id: 'r1', name: 'Walls', color: '#e53935' }),
      ifcRule({ id: 'r2', name: 'Doors', color: '#1e88e5', groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcDoor'] }] }] }),
    ];
    useViewerStore.setState({
      savedLenses: [ruleLens(rules)],
      activeLensId: 'lens-rules',
      lensRuleCounts: new Map([['r1', 5], ['r2', 0]]),
      lensRuleIsolation: { ruleId: 'r1', entityIds: [1, 2, 3] },
    });
    const container = render(<LensPanel />);
    const english = chromeStrings(container);
    assert.ok(english.has(lensPanelEn['lensPanel.ruleRow.isolateTooltip'] as string));
    assert.ok(english.has(lensPanelEn['lensPanel.ruleRow.emptyTooltip'] as string));
    assert.ok(english.has(lensPanelEn['lensPanel.isolatedBadge'] as string));
    assert.ok([...english].some((s) => s.includes('2 rules')));
    assert.ok(english.has(lensPanelEn['lensPanel.card.editTooltip'] as string));
    assert.ok(english.has(lensPanelEn['lensPanel.card.deleteTooltip'] as string));

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertMarked(after, 'lensPanel.ruleRow.isolateTooltip');
    assertMarked(after, 'lensPanel.ruleRow.emptyTooltip');
    assertMarked(after, 'lensPanel.isolatedBadge');
    assertMarked(after, 'lensPanel.card.ruleCount', { count: 2 });
    assertMarked(after, 'lensPanel.card.editTooltip');
    assertMarked(after, 'lensPanel.card.deleteTooltip');
  });

  it('auto-color lens card: active shows legend rows, isolate tooltip, sort control, and legend count', () => {
    useViewerStore.setState({
      savedLenses: [autoColorLens()],
      activeLensId: 'lens-auto',
      lensAutoColorLegend: AUTOCOLOR_LEGEND,
    });
    const container = render(<LensPanel />);
    const english = chromeStrings(container);
    assert.ok(english.has(lensPanelEn['lensPanel.autoColorRow.isolateTooltip'] as string));
    assert.ok(english.has(lensPanelEn['lensPanel.card.sortLegendTooltip'] as string));
    assert.ok([...english].some((s) => s.includes('2 values')));

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertMarked(after, 'lensPanel.autoColorRow.isolateTooltip');
    assertMarked(after, 'lensPanel.card.sortLegendTooltip');
    assertMarked(after, 'lensPanel.card.legendValuesCount', { count: 2 });
  });

  it('auto-color lens card: inactive shows its source-type badge instead of the legend', () => {
    useViewerStore.setState({
      savedLenses: [autoColorLens()],
      activeLensId: null,
    });
    const container = render(<LensPanel />);
    const english = chromeStrings(container);
    assert.ok(english.has(lensPanelEn['lensPanel.type.material'] as string), 'inactive auto-color card should show its source type label');

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertMarked(after, 'lensPanel.type.material');
  });

  it('duplicate-into-editable-copy tooltip differs for a builtin lens', () => {
    useViewerStore.setState({ savedLenses: [{ ...ruleLens([ifcRule()]), builtin: true }] });
    const container = render(<LensPanel />);
    const english = chromeStrings(container);
    assert.ok(english.has(lensPanelEn['lensPanel.card.duplicateBuiltinTooltip'] as string));

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertMarked(after, 'lensPanel.card.duplicateBuiltinTooltip');
  });

  it('manual rule shell translates action and management controls around the shared FilterGroup editor', () => {
    const container = render(
      <LensRuleEditor rule={ifcRule()} index={0} onChange={mock.fn()}
        onRemove={noop} onDuplicate={noop} onMove={mock.fn<(from: number, to: number) => void>()} />,
    );
    const keys = [
      'lensPanel.ruleEditor.duplicateTooltip', 'lensPanel.ruleEditor.removeTooltip',
      'lensPanel.ruleEditor.reorderAriaLabel', 'lensPanel.ruleEditor.reorderTooltip',
      'lensPanel.action.colorize', 'lensPanel.action.transparent', 'lensPanel.action.hide',
    ] as LensPanelKey[];
    const english = chromeStrings(container);
    for (const key of keys) assert.ok(english.has(lensPanelEn[key] as string), key);

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    for (const key of keys) assertMarked(after, key);
  });

  it('auto-color editor: field labels, source options, select placeholders, and the "Show unclassified" toggle', () => {
    const container = render(
      <AutoColorEditor
        initial={{ name: 'Color by System', autoColor: { source: 'classification', psetName: '' } }}
        onSave={noop}
        onCancel={noop}
        discovered={null}
        onRequestDiscovery={noop}
      />,
    );
    const english = chromeStrings(container);
    for (const key of [
      'lensPanel.autoColor.namePlaceholder', 'lensPanel.autoColor.byDistinctValues', 'lensPanel.autoColor.sourceLabel',
      'lensPanel.autoColor.systemLabel', 'lensPanel.autoColor.selectSystemPlaceholder', 'lensPanel.autoColor.showUnclassified',
      'lensPanel.editor.save', 'lensPanel.editor.cancel',
    ] as LensPanelKey[]) {
      assert.ok(english.has(lensPanelEn[key] as string), `expected "${lensPanelEn[key]}" (${key}) visible`);
    }

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    for (const key of [
      'lensPanel.autoColor.namePlaceholder', 'lensPanel.autoColor.byDistinctValues', 'lensPanel.autoColor.sourceLabel',
      'lensPanel.autoColor.systemLabel', 'lensPanel.autoColor.selectSystemPlaceholder', 'lensPanel.autoColor.showUnclassified',
      'lensPanel.editor.save', 'lensPanel.editor.cancel',
    ] as LensPanelKey[]) {
      assertMarked(after, key);
    }
  });

  it('auto-color editor: attribute source shows "Name" label, "Select..." option, and property/quantity select placeholders', () => {
    const container = render(
      <AutoColorEditor
        initial={{ name: '', autoColor: { source: 'attribute', propertyName: '' } }}
        onSave={noop}
        onCancel={noop}
        discovered={null}
        onRequestDiscovery={noop}
      />,
    );
    const english = chromeStrings(container);
    assert.ok(english.has(lensPanelEn['lensPanel.autoColor.nameLabel'] as string));
    assert.ok(english.has(lensPanelEn['lensPanel.autoColor.selectPlaceholderOption'] as string));

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    assertMarked(chromeStrings(container), 'lensPanel.autoColor.nameLabel');
    assertMarked(chromeStrings(container), 'lensPanel.autoColor.selectPlaceholderOption');
    cleanup();
    act(() => setLocale('en'));

    const container2 = render(
      <AutoColorEditor
        initial={{ name: '', autoColor: { source: 'property', psetName: '', propertyName: '' } }}
        onSave={noop}
        onCancel={noop}
        discovered={null}
        onRequestDiscovery={noop}
      />,
    );
    assert.ok(chromeStrings(container2).has(lensPanelEn['lensPanel.autoColor.psetLabel'] as string));
    assert.ok(chromeStrings(container2).has(lensPanelEn['lensPanel.autoColor.selectPropertySetPlaceholder'] as string));
    assert.ok(chromeStrings(container2).has(lensPanelEn['lensPanel.autoColor.selectPropertyPlaceholder'] as string));
    act(() => setLocale(PSEUDO_LOCALE));
    assertMarked(chromeStrings(container2), 'lensPanel.autoColor.psetLabel');
    assertMarked(chromeStrings(container2), 'lensPanel.autoColor.selectPropertySetPlaceholder');
    assertMarked(chromeStrings(container2), 'lensPanel.autoColor.selectPropertyPlaceholder');
    cleanup();
    act(() => setLocale('en'));

    const container3 = render(
      <AutoColorEditor
        initial={{ name: '', autoColor: { source: 'quantity', psetName: '', propertyName: '' } }}
        onSave={noop}
        onCancel={noop}
        discovered={null}
        onRequestDiscovery={noop}
      />,
    );
    assert.ok(chromeStrings(container3).has(lensPanelEn['lensPanel.autoColor.qsetLabel'] as string));
    assert.ok(chromeStrings(container3).has(lensPanelEn['lensPanel.autoColor.selectQuantitySetPlaceholder'] as string));
    assert.ok(chromeStrings(container3).has(lensPanelEn['lensPanel.autoColor.selectQuantityPlaceholder'] as string));
    act(() => setLocale(PSEUDO_LOCALE));
    assertMarked(chromeStrings(container3), 'lensPanel.autoColor.qsetLabel');
    assertMarked(chromeStrings(container3), 'lensPanel.autoColor.selectQuantitySetPlaceholder');
    assertMarked(chromeStrings(container3), 'lensPanel.autoColor.selectQuantityPlaceholder');
  });

  it('lens editor (rule authoring): name placeholder and "Add Rule" button', () => {
    useViewerStore.setState({
      savedLenses: [],
    });
    const container = render(<LensPanel />);
    const newRuleLensButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(lensPanelEn['lensPanel.newRuleLensButton'] as string));
    assert.ok(newRuleLensButton, 'New Rule Lens button not found');
    act(() => newRuleLensButton!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })));

    const english = chromeStrings(container);
    assert.ok(english.has(lensPanelEn['lensPanel.editor.namePlaceholder'] as string));
    assert.ok(english.has(lensPanelEn['lensPanel.editor.addRule'] as string));
    assert.ok(english.has(lensPanelEn['lensPanel.editor.save'] as string));
    assert.ok(english.has(lensPanelEn['lensPanel.editor.cancel'] as string));

    registerLocale(PSEUDO_LOCALE, PSEUDO);
    act(() => setLocale(PSEUDO_LOCALE));
    const after = chromeStrings(container);
    assertMarked(after, 'lensPanel.editor.namePlaceholder');
    assertMarked(after, 'lensPanel.editor.addRule');
    assertMarked(after, 'lensPanel.editor.save');
    assertMarked(after, 'lensPanel.editor.cancel');
  });
});
