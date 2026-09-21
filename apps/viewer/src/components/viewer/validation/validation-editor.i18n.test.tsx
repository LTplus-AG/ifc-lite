/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RuleSetEditor` and its children read the i18n catalogue (#5138
 * `validation-editor.en.ts`): every field label, placeholder, aria-label
 * and segmented-control option across the requirement-kind editors, the
 * "between" chip, the chips/selector toggle, and the model picker.
 *
 * Same oracle shape as `ChartEditor.i18n.test.tsx`: a pseudo-locale marks
 * every `validationEditor.*` key, the editor is mounted with one rule of
 * EACH requirement kind (Element with a folded "between" pair, Unique,
 * Aggregate with `groupBy`+`universe`, Compare as a date) plus the
 * Advanced disclosure opened and an unresolved model-fingerprint target —
 * the locale is switched live, and every marked string that was readable
 * in English must reappear marked.
 */
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup, click } from '@/test/render.js';
import { registerLocale, setLocale, type Catalogue } from '@/i18n';
import { validationEditorEn } from '@/i18n/catalogues/validation-editor.en';
import type { RuleSetFile } from '@/lib/validation/rule-set';
import { RuleSetEditor } from './RuleSetEditor';

type Key = keyof typeof validationEditorEn;
const ALL_KEYS = Object.keys(validationEditorEn) as Key[];
const STATIC_KEYS = ALL_KEYS.filter((key) => {
  const value = validationEditorEn[key];
  return typeof value === 'string' && !value.includes('{');
});

const mark = (key: Key) => `⟦${key}|${String(validationEditorEn[key])}⟧`;
const PSEUDO: Catalogue = Object.fromEntries(ALL_KEYS.map((key) => [key, mark(key)])) as Catalogue;

function readableStrings(container: HTMLElement): Set<string> {
  const out = new Set<string>();
  container.querySelectorAll('*').forEach((element) => {
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
  return out;
}

function foundText(strings: Set<string>, text: string): boolean {
  if (strings.has(text)) return true;
  for (const s of strings) {
    if (s.includes(text)) return true;
  }
  return false;
}

/** One rule of each requirement kind, an `element` block with a foldable
 *  `gte`+`lte` pair (the "between" chip), an `aggregate` with `groupBy` +
 *  `universe` (the "Define groups from…" section), and a `compare` in
 *  date mode — every kind-specific field this catalogue covers renders
 *  from this single fixture. */
function fixtureFile(): RuleSetFile {
  const anyBlock = { groups: [{ rules: [], combinator: 'AND' as const }], authoredAs: 'chips' as const };
  return {
    version: 1,
    name: 'Fixture rule set',
    targets: { modelFingerprints: ['fp-not-loaded'] },
    rules: [
      {
        id: 'r1', name: 'Wall fire rating range',
        applicability: {
          groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in', exactClass: true }], combinator: 'AND' }],
          authoredAs: 'chips',
        },
        requirement: {
          kind: 'element',
          block: {
            groups: [{
              rules: [
                { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width', op: 'gte', value: 100 },
                { kind: 'quantity', setName: 'Qto_WallBaseQuantities', quantityName: 'Width', op: 'lte', value: 300 },
              ],
              combinator: 'AND',
            }],
            authoredAs: 'chips',
          },
        },
      },
      {
        id: 'r2', name: 'Unique mark',
        applicability: anyBlock,
        requirement: { kind: 'unique', subject: { kind: 'attribute', name: 'Mark' }, scope: 'perModel' },
      },
      {
        id: 'r5', name: 'Unique classification',
        applicability: anyBlock,
        requirement: { kind: 'unique', subject: { kind: 'classification' } },
      },
      {
        id: 'r3', name: 'Total floor area',
        applicability: anyBlock,
        requirement: {
          kind: 'aggregate',
          fn: 'sum',
          subject: { kind: 'quantity', setName: 'Qto_SpaceBaseQuantities', quantityName: 'NetFloorArea' },
          groupBy: { subject: { kind: 'parent' }, universe: anyBlock },
          op: 'gt',
          value: 300,
        },
      },
      {
        id: 'r4', name: 'Warranty dates',
        applicability: anyBlock,
        requirement: {
          kind: 'compare',
          left: { kind: 'property', setName: 'Pset_Warranty', propertyName: 'Start' },
          right: { kind: 'property', setName: 'Pset_Warranty', propertyName: 'End' },
          op: 'lt',
          valueType: 'date',
        },
      },
    ],
  };
}

function mount(): HTMLElement {
  const container = render(
    <RuleSetEditor file={fixtureFile()} onChange={() => {}} models={[{ id: 'm1', name: 'Model A' }]} />,
  );
  // Open every card's Advanced disclosure so Case sensitive / Tolerance /
  // cardinality render too.
  for (const button of [...container.querySelectorAll('button')]) {
    if (button.textContent?.includes('Advanced')) click(button);
  }
  return container;
}

/** A rule set with no rules yet — the only state `ruleSetEditor.emptyRulesHint`
 *  renders in (the populated fixture above always has rules). */
function mountEmpty(): HTMLElement {
  return render(
    <RuleSetEditor
      file={{ version: 1, name: 'Empty', rules: [] }}
      onChange={() => {}}
      models={[{ id: 'm1', name: 'Model A' }]}
    />,
  );
}

beforeEach(() => {
  setLocale('en');
});

afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('validation rule editor localization (#5138)', () => {
  it('translates every static key rendered across the four requirement kinds', () => {
    const containers = [mount(), mountEmpty()];
    const english = new Set<string>();
    for (const c of containers) for (const s of readableStrings(c)) english.add(s);

    registerLocale('validation-editor-pseudo', PSEUDO);
    act(() => setLocale('validation-editor-pseudo'));
    const after = new Set<string>();
    for (const c of containers) for (const s of readableStrings(c)) after.add(s);
    act(() => setLocale('en'));

    for (const key of STATIC_KEYS) {
      const text = String(validationEditorEn[key]);
      if (!foundText(english, text)) continue;
      assert.ok(foundText(after, mark(key)), `${key}: "${text}" must be translated, marked text not found`);
    }
  });

  it('accounts for every static key: rendered by the fixtures, or intentionally not', () => {
    const containers = [mount(), mountEmpty()];
    const english = new Set<string>();
    for (const c of containers) for (const s of readableStrings(c)) english.add(s);
    // `notLoaded` needs a target fingerprint NOT among `models` — the
    // fixture's `fp-not-loaded` gives it that, so every static key should
    // be reachable from these two mounts.
    const unaccounted = STATIC_KEYS.filter((key) => !foundText(english, String(validationEditorEn[key])));
    assert.deepEqual(unaccounted, [], 'key not rendered by the fixtures — extend them or document the gap');
  });
});
