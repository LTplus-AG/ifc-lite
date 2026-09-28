/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The requirement text field has no spelling for a complex-property
 * `memberPath` (#5475). Re-parsing the text would drop the path and widen a
 * member check to the whole property, so the field is read-only then.
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import type { Requirement } from '@ifc-lite/rules';
import { RequirementEditor } from './RuleSetEditor.requirementEditor.js';

afterEach(cleanup);

function textField(requirement: Requirement): HTMLInputElement {
  const container = render(<RequirementEditor requirement={requirement} onChange={() => {}} models={[]} />);
  const input = container.querySelector('input[aria-label="Requirement, as text"]');
  assert.ok(input instanceof window.HTMLInputElement, 'no requirement text field rendered');
  return input;
}

describe('requirement text field and memberPath (#5475)', () => {
  it('is read-only when a subject reads a complex-property member', () => {
    const input = textField({
      kind: 'aggregate', fn: 'sum', op: 'lte', value: 5,
      subject: { kind: 'property', setName: 'Pset_Test', propertyName: 'Dims', memberPath: ['Width'] },
    });
    assert.equal(input.readOnly, true);
  });

  it('stays editable otherwise', () => {
    const input = textField({
      kind: 'aggregate', fn: 'sum', op: 'lte', value: 5,
      subject: { kind: 'property', setName: 'Pset_Test', propertyName: 'Dims' },
    });
    assert.equal(input.readOnly, false);
  });
});
