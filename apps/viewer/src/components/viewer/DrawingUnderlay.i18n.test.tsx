/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression coverage for the #4918 slice's `drawing-underlay.en.ts`
 * catalogue and its two consumers: `DrawingSettingsPanel.tsx` (graphic
 * override presets and custom rules) and `DxfUnderlayPanel.tsx` (imported
 * DXF reference underlays). One file for the pair since they share a
 * single catalogue namespace (`drawingUnderlay.*`), same reasoning as
 * `Hierarchy.i18n.test.tsx`/`Properties.i18n.test.tsx` covering several
 * files of one feature.
 *
 * Same pseudo-locale-oracle shape as `LayerMergeSection.i18n.test.tsx`:
 * `readableStrings` collects both text nodes and the
 * `aria-label`/`title`/`placeholder` attribute values this catalogue
 * covers (most of `DxfUnderlayPanel`'s strings are `title` attributes, not
 * visible text), every catalogue string is marked, the store is seeded
 * with enough state to exercise both components' non-trivial branches (a
 * custom rule being edited, a DXF underlay with warnings/skipped entities/
 * an "auto" georeference), the locale is switched live, and every marked
 * string that was readable in English must reappear marked.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import type { TranslationValue, PluralTranslation } from '@/i18n';
import type { drawingUnderlayEn as DrawingUnderlayEnType } from '@/i18n/catalogues/drawing-underlay.en';
import { useViewerStore } from '@/store';
import type { GraphicOverrideRule } from '@ifc-lite/drawing-2d';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice';
import { DrawingSettingsPanel } from './DrawingSettingsPanel.js';
import { DxfUnderlayPanel } from './DxfUnderlayPanel.js';

// Dynamic + try/catch (not a static import): a revert of this slice's
// production change deletes drawing-underlay.en.ts entirely, and a static
// import would fail the whole test FILE to load (ERR_MODULE_NOT_FOUND)
// rather than let the assertions below fail on their own merits — see
// WebGpuTroubleshooting.i18n.test.tsx for the same pattern.
let drawingUnderlayEnLoaded: typeof DrawingUnderlayEnType | undefined;
try {
  ({ drawingUnderlayEn: drawingUnderlayEnLoaded } = await import('@/i18n/catalogues/drawing-underlay.en'));
} catch {
  drawingUnderlayEnLoaded = undefined;
}
const drawingUnderlayEn = drawingUnderlayEnLoaded ?? ({} as typeof DrawingUnderlayEnType);

type Key = keyof typeof drawingUnderlayEn;
const ALL_KEYS = Object.keys(drawingUnderlayEn) as Key[];

function markValue(value: TranslationValue): TranslationValue {
  if (typeof value === 'string') return `⟦${value}⟧`;
  const marked: Record<string, string> = {};
  for (const [category, text] of Object.entries(value as PluralTranslation)) {
    if (typeof text === 'string') marked[category] = `⟦${text}⟧`;
  }
  return marked as PluralTranslation;
}
const PSEUDO: Catalogue = Object.fromEntries(ALL_KEYS.map((key) => [key, markValue(drawingUnderlayEn[key]!)]));

const RULE_BEING_EDITED: GraphicOverrideRule = {
  id: 'test-rule-edited',
  name: 'Test Rule Edited',
  enabled: true,
  priority: 100,
  criteria: { type: 'all' },
  style: { fillColor: '#808080', strokeColor: '#000000', lineWeight: 0.4 },
};
const RULE_COLLAPSED: GraphicOverrideRule = {
  id: 'test-rule-collapsed',
  name: 'Test Rule Collapsed',
  enabled: true,
  priority: 101,
  criteria: { type: 'all' },
  style: {},
};

const DXF_UNDERLAY: DxfUnderlayState = {
  id: 'test-dxf-1',
  name: 'site-plan.dxf',
  underlay: {
    name: 'site-plan.dxf',
    layers: [],
    bounds: { min: { x: 0, y: 0 }, max: { x: 1, y: 1 } },
    unitScale: 1,
    skipped: { IfcFurnishingElement: 2 },
    warnings: ['Warning one', 'Warning two'],
  },
  visible: true,
  visible3D: true,
  opacity: 0.8,
  layerVisibility: {},
  placement: { offsetX: 0, offsetY: 0, rotationDeg: 0, scale: 1 },
  georeferenced: undefined,
};

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

beforeEach(() => {
  registerLocale('drawing-underlay-pseudo', PSEUDO);
  setLocale('en');
  useViewerStore.setState({
    overridesEnabled: true,
    activePresetId: 'preset-monochrome',
    customOverrideRules: [RULE_BEING_EDITED, RULE_COLLAPSED],
    dxfUnderlays: [DXF_UNDERLAY],
  });
});

afterEach(() => {
  cleanup();
  setLocale('en');
  useViewerStore.setState({
    overridesEnabled: true,
    activePresetId: 'preset-3d-colors',
    customOverrideRules: [],
    dxfUnderlays: [],
  });
});

describe('DrawingSettingsPanel + DxfUnderlayPanel localization (#4918)', () => {
  it('renders the English catalogue by default, including the active preset, the custom-rule editor, and a DXF underlay with warnings', () => {
    const settings = render(<DrawingSettingsPanel />);
    assert.match(settings.textContent ?? '', /Enabled/);
    assert.match(settings.textContent ?? '', /Style Presets/);
    assert.match(settings.textContent ?? '', /Rules/);
    assert.match(settings.textContent ?? '', /Custom Rules/);
    assert.match(settings.textContent ?? '', /2 rules/);
    assert.match(settings.textContent ?? '', /Click to edit/);

    // Open the editor for RULE_BEING_EDITED to reach its form fields.
    const editRow = Array.from(settings.querySelectorAll('button')).find(
      (el) => el.textContent?.includes('Test Rule Edited'),
    );
    assert.ok(editRow, 'expected the collapsed row for the rule being edited');
    act(() => (editRow as HTMLElement).click());
    assert.match(settings.textContent ?? '', /Rule Name/);
    assert.match(settings.textContent ?? '', /IFC Class/);
    assert.match(settings.textContent ?? '', /Fill Color/);
    assert.match(settings.textContent ?? '', /Stroke Color/);
    assert.match(settings.textContent ?? '', /Line Weight/);
    assert.match(settings.textContent ?? '', /mm/);
    assert.match(settings.textContent ?? '', /Delete/);
    assert.match(settings.textContent ?? '', /Done/);

    const dxf = render(
      <DxfUnderlayPanel onCenterOnModel={() => {}} planViewActive georeferenceAvailable />,
    );
    assert.match(dxf.textContent ?? '', /Import DXF\.\.\./);
    assert.match(dxf.textContent ?? '', /0 layers/);
    assert.match(dxf.textContent ?? '', /Warning one/);
    assert.match(dxf.textContent ?? '', /\(\+1 more\)/);
    assert.match(dxf.textContent ?? '', /Not imported:/);
    assert.match(dxf.textContent ?? '', /Opacity \(2D\)/);
    assert.match(dxf.textContent ?? '', /Align to model georeference \(auto\)/);
    assert.match(dxf.textContent ?? '', /Placement/);
  });

  it('translates every catalogue key rendered across both components', () => {
    const settings = render(<DrawingSettingsPanel />);
    const editRow = Array.from(settings.querySelectorAll('button')).find(
      (el) => el.textContent?.includes('Test Rule Edited'),
    );
    assert.ok(editRow);
    act(() => (editRow as HTMLElement).click());

    const dxf = render(
      <DxfUnderlayPanel onCenterOnModel={() => {}} planViewActive georeferenceAvailable />,
    );

    const renders = [settings, dxf];
    const englishDom = new Set<string>();
    for (const r of renders) for (const s of readableStrings(r)) englishDom.add(s);

    act(() => setLocale('drawing-underlay-pseudo'));
    const afterDom = new Set<string>();
    for (const r of renders) for (const s of readableStrings(r)) afterDom.add(s);
    act(() => setLocale('en'));

    for (const key of ALL_KEYS) {
      const value = drawingUnderlayEn[key];
      const text = typeof value === 'string' ? value : (value as PluralTranslation).other;
      if (!englishDom.has(text.trim())) continue; // not exercised by this render's branches
      const marked = markValue(value);
      const markedText = typeof marked === 'string' ? marked : (marked as PluralTranslation).other;
      assert.ok(afterDom.has(markedText.trim()), `${String(key)}: "${text}" must be translated`);
    }
  });

  it('lets a registered locale translate a key and falls back to English for one it omits', () => {
    registerLocale('drawing-underlay-partial', {
      'drawingUnderlay.settings.presetsHeading': 'STYLES PRÉDÉFINIS',
    } as Catalogue);
    setLocale('drawing-underlay-partial');
    const settings = render(<DrawingSettingsPanel />);
    assert.match(settings.textContent ?? '', /STYLES PRÉDÉFINIS/);
    // 'drawingUnderlay.settings.customRulesHeading' was not overridden: still English.
    assert.match(settings.textContent ?? '', /Custom Rules/);
    setLocale('en');
  });
});
