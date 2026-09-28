/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { cleanup, render, type } from '@/test/render.js';
import type { Subject } from '@ifc-lite/rules';
import { SubjectPicker } from './SubjectPicker.js';

function Harness({ initial, onSubjectChange }: { initial: Subject; onSubjectChange?: (subject: Subject) => void }) {
  const [subject, setSubject] = useState(initial);
  return (
    <SubjectPicker
      subject={subject}
      onChange={(next) => { setSubject(next); onSubjectChange?.(next); }}
    />
  );
}

describe('SubjectPicker input names (#6342)', () => {
  afterEach(cleanup);

  it('distinguishes property, quantity, group, and classification fields when placeholders disappear', () => {
    const cases: Array<{ subject: Subject; names: string[] }> = [
      { subject: { kind: 'attribute', name: '' }, names: ['Attribute name'] },
      { subject: { kind: 'property', setName: '', propertyName: '' }, names: ['Property set name', 'Property name', 'Complex property member'] },
      { subject: { kind: 'quantity', setName: '', quantityName: '' }, names: ['Quantity set name', 'Quantity name'] },
      { subject: { kind: 'group' }, names: ['Group class'] },
      { subject: { kind: 'classification' }, names: ['Classification system'] },
    ];

    for (const { subject, names } of cases) {
      const container = render(<Harness initial={subject} />);
      const inputs = [...container.querySelectorAll('input')];
      assert.deepEqual(inputs.map((input) => input.getAttribute('aria-label')), names);
      cleanup();
    }
  });

  it('edits the named property name without changing the set name', () => {
    let latest: Subject | undefined;
    const container = render(
      <Harness
        initial={{ kind: 'property', setName: 'Pset_WallCommon', propertyName: '' }}
        onSubjectChange={(subject) => { latest = subject; }}
      />,
    );
    const propertyName = container.querySelector('input[aria-label="Property name"]');
    assert.ok(propertyName instanceof window.HTMLInputElement);
    type(propertyName, 'FireRating');
    assert.ok(latest && latest.kind === 'property');
    assert.equal(latest.setName, 'Pset_WallCommon');
    assert.equal(latest.propertyName, 'FireRating');
  });
});
