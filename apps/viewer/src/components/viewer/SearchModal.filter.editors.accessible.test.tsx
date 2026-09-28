/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Rule, type FilterRule } from '@ifc-lite/rules';
import { cleanup, render, type } from '@/test/render.js';
import { AttributeEditor, GlobalIdEditor } from './SearchModal.filter.editors.identity.js';
import { ClassificationEditor } from './SearchModal.filter.editors.membership.js';

afterEach(cleanup);

describe('Search filter chip input names (#6342)', () => {
  it('keeps GlobalId values named when the example is replaced', () => {
    const commits: string[][] = [];
    const container = render(<GlobalIdEditor values={['GUID-A']} op="in" onChange={(values) => commits.push(values)} />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="GlobalId values"]');
    assert.ok(input);
    type(input, 'GUID-A, GUID-B');
    assert.deepEqual(commits.at(-1), ['GUID-A', 'GUID-B']);
    assert.equal(input.getAttribute('aria-label'), 'GlobalId values');
  });

  it('distinguishes an attribute name from its value', () => {
    const commits: FilterRule[] = [];
    const rule: Extract<FilterRule, { kind: 'attribute' }> = Rule.attribute('Description', 'eq', 'Wall');
    const container = render(<AttributeEditor rule={rule} onChange={(next) => commits.push(next)} />);
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Attribute name"]');
    const value = container.querySelector<HTMLInputElement>('input[aria-label="Attribute value"]');
    assert.ok(name && value);
    type(name, 'ObjectType');
    assert.deepEqual(commits.at(-1), { ...rule, name: 'ObjectType' });
    type(value, 'Curtain');
    assert.deepEqual(commits.at(-1), { ...rule, value: 'Curtain', valueKind: undefined });
  });

  it('names a classification value separately from its optional system', () => {
    const commits: FilterRule[] = [];
    const container = render(<ClassificationEditor
      rule={Rule.classification('Uniclass', 'eq', 'A')}
      valueSchema={null}
      onChange={(next) => commits.push(next)}
    />);
    const value = container.querySelector<HTMLInputElement>('input[aria-label="Classification code or name"]');
    assert.ok(value);
    type(value, 'B');
    assert.deepEqual(commits.at(-1), Rule.classification('Uniclass', 'eq', 'B'));
    assert.equal(value.getAttribute('aria-label'), 'Classification code or name');
  });
});
