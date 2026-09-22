/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Editing a `parent` rule row keeps what its value MEANS (#4903).
 *
 * A `parent=/Level [0-9]/` selector adapts to `valueKind: 'regex'`. A row edit that rebuilt
 * the rule without it would silently turn the pattern into a literal name —
 * still rendered identically, now matching nothing. Asserted on what the
 * rendered input hands `onChange`, against a literal expected rule.
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, type } from '@/test/render.js';
import type { FilterRule } from '@ifc-lite/rules';
import { RuleRow } from './SearchModal.filter.editors.js';

afterEach(cleanup);

describe('RuleRow — parent rule', () => {
  it('keeps valueKind: regex when the value is edited', () => {
    const commits: FilterRule[] = [];
    const container = render(
      <RuleRow
        rule={{ kind: 'parent', op: 'matches', value: 'Level.*', valueKind: 'regex' }}
        tagOptions={new Map()}
        modelOptions={[]}
        ifcTypeOptions={[]}
        storeyOptions={[]}
        psetQto={null}
        valueSchema={null}
        onChange={(next) => commits.push(next)}
        onRemove={() => {}}
      />,
    );
    const input = container.querySelector('input[placeholder="text"]');
    assert.ok(input instanceof window.HTMLInputElement, 'no parent value input rendered');
    type(input, 'Level [0-9]');
    assert.deepEqual(commits, [{ kind: 'parent', op: 'matches', value: 'Level [0-9]', valueKind: 'regex' }]);
  });
});
