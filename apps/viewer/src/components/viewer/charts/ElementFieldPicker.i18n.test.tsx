/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ElementFieldPicker` reads the i18n catalogue (#4918): the field-source
 * label, filter box, and the attribute/property/quantity/relation family
 * controls, including their "(unavailable)" saved-selection fallbacks and
 * the "unavailable in the loaded models" notice. Field/set/binding NAMES
 * (`FireRating`, `Pset_WallCommon`, `Concrete`, …) are runtime IFC content,
 * not literals, and stay out of `STATIC_KEYS` coverage.
 *
 * Same oracle shape as `PrivacyPanel.i18n.test.tsx`: a pseudo-locale marks
 * every `elementFieldPicker.*` string, the picker is mounted once per
 * family (`attribute`, `property`, `quantity`, `relation`) plus once with
 * an unavailable saved selection, the locale is switched live, and every
 * marked string that was readable in English must reappear marked.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { ElementFieldBinding } from '@ifc-lite/charts';
import { render, cleanup } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { chartsEn } from '@/i18n/catalogues/charts.en';
import type { ElementFieldCatalog } from '@/lib/charts/element-field-reader';
import { ElementFieldPicker } from './ElementFieldPicker.js';

type ChartKey = keyof typeof chartsEn;
const ALL_KEYS = Object.keys(chartsEn) as ChartKey[];
const SCOPE_KEYS = ALL_KEYS.filter((key) => key.startsWith('elementFieldPicker.'));
const STATIC_KEYS = SCOPE_KEYS.filter((key) => {
  const value = chartsEn[key];
  return typeof value === 'string' && !value.includes('{');
});

const mark = (key: ChartKey) => `⟦${key}|${String(chartsEn[key])}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(ALL_KEYS.map((key) => [key, mark(key)])) as Catalogue;

function readableStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  container.querySelectorAll('*').forEach((element) => {
    const label = element.getAttribute('aria-label');
    if (label) out.add(label);
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) out.add(placeholder);
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText) out.add(ownText);
  });
  return out;
}

function foundText(strings: Set<string>, text: string): boolean {
  if (strings.has(text)) return true;
  for (const s of strings) {
    if (s.includes(text)) return true;
  }
  return false;
}

const CLASS_NAME = 'field';

function catalog(): ElementFieldCatalog {
  return {
    attributes: [
      { binding: { kind: 'attribute', attributeName: 'Name', valueKind: 'category' }, label: 'Name', observedValue: true },
    ],
    properties: new Map([
      ['Pset_WallCommon', [
        { binding: { kind: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating', valueKind: 'category' }, label: 'FireRating', observedValue: true },
      ]],
    ]),
    quantities: new Map([
      ['Qto_WallBaseQuantities', [
        { binding: { kind: 'quantity', qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetSideArea', valueKind: 'number' }, label: 'NetSideArea', observedValue: true },
      ]],
    ]),
    relations: [
      { binding: { kind: 'material', valueKind: 'category' }, label: 'Material', observedValue: true },
      { binding: { kind: 'classification', valueKind: 'category', system: 'CCI' }, label: 'Classification: CCI', observedValue: true },
    ],
  };
}

/** Mounts the picker with `family` pre-selected via its saved `value`, so
 *  the family's own set/field controls render on the first paint. */
function mountFamily(family: 'attribute' | 'property' | 'quantity' | 'relation', onChange: (value: ElementFieldBinding | undefined) => void): HTMLElement {
  const value: ElementFieldBinding | undefined =
    family === 'attribute' ? { kind: 'attribute', attributeName: 'Name', valueKind: 'category' }
    : family === 'property' ? { kind: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating', valueKind: 'category' }
    : family === 'quantity' ? { kind: 'quantity', qsetName: 'Qto_WallBaseQuantities', quantityName: 'NetSideArea', valueKind: 'number' }
    : { kind: 'material', valueKind: 'category' };
  return render(
    <ElementFieldPicker value={value} catalog={catalog()} loading={false} className={CLASS_NAME} onChange={onChange} />,
  );
}

/** An unavailable saved classification selection: exercises the relation
 *  fallback option AND the "unavailable in the loaded models" notice. */
function mountUnavailable(onChange: (value: ElementFieldBinding | undefined) => void): HTMLElement {
  const value: ElementFieldBinding = { kind: 'classification', valueKind: 'category', system: 'Uniclass' };
  return render(
    <ElementFieldPicker value={value} catalog={catalog()} loading={false} className={CLASS_NAME} onChange={onChange} />,
  );
}

/** `fieldLabelLoading` needs `loading={true}`; only the dedicated last test mounts that. */
const NOT_RENDERED_IN_THIS_STATE: ChartKey[] = ['elementFieldPicker.fieldLabelLoading'];

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('ElementFieldPicker localization (#4918)', () => {
  it('translates every static key rendered across every family and the unavailable-selection state', () => {
    const noop = () => {};
    const containers = [
      mountFamily('attribute', noop),
      mountFamily('property', noop),
      mountFamily('quantity', noop),
      mountFamily('relation', noop),
      mountUnavailable(noop),
    ];

    const english = new Set<string>();
    for (const c of containers) for (const s of readableStrings(c)) english.add(s);

    registerLocale('element-field-picker-pseudo', PSEUDO);
    act(() => setLocale('element-field-picker-pseudo'));
    const after = new Set<string>();
    for (const c of containers) for (const s of readableStrings(c)) after.add(s);

    const covered = new Set<ChartKey>();
    for (const key of STATIC_KEYS) {
      const text = String(chartsEn[key]);
      if (!foundText(english, text)) continue;
      assert.ok(foundText(after, mark(key)), `${key}: "${text}" must be translated, marked text not found`);
      covered.add(key);
    }

    for (const key of covered) {
      assert.ok(
        !NOT_RENDERED_IN_THIS_STATE.includes(key),
        `${key}: covered by this render, drop it from NOT_RENDERED_IN_THIS_STATE`,
      );
    }
  });

  it('accounts for every static key: rendered here, or documented as not rendered in this state', () => {
    const noop = () => {};
    const containers = [
      mountFamily('attribute', noop),
      mountFamily('property', noop),
      mountFamily('quantity', noop),
      mountFamily('relation', noop),
      mountUnavailable(noop),
    ];
    const english = new Set<string>();
    for (const c of containers) for (const s of readableStrings(c)) english.add(s);

    const seen = STATIC_KEYS.filter((key) => foundText(english, String(chartsEn[key])));
    const unaccounted = STATIC_KEYS.filter(
      (key) => !seen.includes(key) && !NOT_RENDERED_IN_THIS_STATE.includes(key),
    );
    assert.deepEqual(unaccounted, [], 'key neither rendered nor listed in NOT_RENDERED_IN_THIS_STATE');
  });

  it('interpolates the unavailable-option and classification-name templates under a live locale switch', () => {
    registerLocale('fr-FR', {
      'elementFieldPicker.unavailableRelationOption': '{name} (indisponible, fr)',
      'elementFieldPicker.classificationName': 'Classement : {system}',
    } as Catalogue);
    setLocale('fr-FR');

    const container = mountUnavailable(() => {});
    assert.match(container.textContent ?? '', /Classement : Uniclass \(indisponible, fr\)/);
  });

  it('renders the English catalogue value by default for the loading state', () => {
    const container = render(
      <ElementFieldPicker value={undefined} catalog={catalog()} loading={true} className={CLASS_NAME} onChange={() => {}} />,
    );
    assert.match(container.textContent ?? '', /Element field \(discovering…\)/);
  });
});
