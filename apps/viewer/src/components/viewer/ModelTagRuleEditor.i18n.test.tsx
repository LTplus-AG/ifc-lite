/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ModelTagRuleEditor`'s own chrome reads the i18n catalogue (#4918 sweep,
 * `misc-panels-b.en.ts`). Same shape as `MergeLayersBanner.i18n.test.tsx`:
 * render with the default (English) locale, then register a partial
 * locale overriding a couple of keys and assert the swap lands while an
 * untranslated key still falls back to English. The plural
 * `unresolvedWarning` key is exercised at both the `one` and `other`
 * boundary (a single dangling tag id vs. two).
 */
import '@/test/setup-dom.js';
import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render';
import { registerLocale, setLocale } from '@/i18n';
import { Rule, type ModelTagRule } from '@ifc-lite/rules';
import type { ModelTag } from '@ifc-lite/rules';
import { ModelTagRuleEditor } from './ModelTagRuleEditor';

afterEach(() => {
  cleanup();
  setLocale('en');
});

const TAG_A: ModelTag = { id: 'tag-a', name: 'Structural' };

it('renders the "no tags" empty state and pick-tags placeholder in English by default (#4918)', () => {
  const rule: ModelTagRule = Rule.modelTag('hasAny', []);
  const container = render(
    <ModelTagRuleEditor rule={rule} tags={new Map()} onChange={() => {}} />,
  );
  assert.ok(container.textContent?.includes('Pick tags…'));
  const trigger = container.querySelector('button[aria-label="Pick model tags"]');
  assert.ok(trigger, 'expected the tag-picker trigger button');
});

it('pluralizes the unresolved-tag warning at one and at two (#4918)', () => {
  const rule: ModelTagRule = Rule.modelTag('hasAny', ['missing-1']);
  const one = render(
    <ModelTagRuleEditor rule={rule} tags={new Map([['tag-a', TAG_A]])} onChange={() => {}} />,
  );
  assert.ok(one.textContent?.includes('A tag in this rule no longer exists — the rule matches nothing until it is fixed.'));

  const twoRule: ModelTagRule = Rule.modelTag('hasAny', ['missing-1', 'missing-2']);
  const two = render(
    <ModelTagRuleEditor rule={twoRule} tags={new Map([['tag-a', TAG_A]])} onChange={() => {}} />,
  );
  assert.ok(two.textContent?.includes('2 tags in this rule no longer exist — the rule matches nothing until it is fixed.'));
});

it('translates the pick-tags aria-label and the plural warning, while an untranslated key falls back to English (#4918)', () => {
  registerLocale('de-DE', {
    'modelTagRuleEditor.pickTagsAriaLabel': 'Modell-Tags auswählen',
    'modelTagRuleEditor.unresolvedWarning': {
      one: 'Ein Tag in dieser Regel existiert nicht mehr (de).',
      other: '{count} Tags in dieser Regel existieren nicht mehr (de).',
    },
  });
  act(() => setLocale('de-DE'));
  const rule: ModelTagRule = Rule.modelTag('hasAny', ['missing-1', 'missing-2']);
  const container = render(
    <ModelTagRuleEditor rule={rule} tags={new Map([['tag-a', TAG_A]])} onChange={() => {}} />,
  );
  assert.ok(container.querySelector('button[aria-label="Modell-Tags auswählen"]'));
  assert.ok(container.textContent?.includes('2 Tags in dieser Regel existieren nicht mehr (de).'));
  // `pickTagsPlaceholder` is not in the partial locale: must still fall back
  // (rendered once the dropdown is opened; here we assert the trigger's own
  // English selected-count text instead, since two ids are selected).
  assert.ok(container.textContent?.includes('2 selected'));
});
