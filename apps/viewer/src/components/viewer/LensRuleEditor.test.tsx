/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LensRuleEditorProps } from './LensRuleEditor.js';

type GroupRule = LensRuleEditorProps['rule'];

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
async function render(rule: GroupRule, onChange = mock.fn()): Promise<{ container: HTMLElement; onChange: typeof onChange }> {
  const editor = await import('./LensRuleEditor.js').catch(() => null);
  assert.ok(editor?.LensRuleEditor, 'the shared Lens rule editor must be available');
  const { LensRuleEditor } = editor;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<LensRuleEditor
    rule={rule} index={0} onChange={onChange} onRemove={() => {}} onDuplicate={() => {}}
  />));
  mounted.push({ root, container });
  return { container, onChange };
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

const baseRule: GroupRule = {
  id: 'r1', name: 'Rated walls', enabled: true,
  groups: [{ combinator: 'AND', rules: [
    { kind: 'ifcType', op: 'in', values: ['IfcWall'] },
    { kind: 'property', setName: 'Pset_WallCommon', propertyName: 'FireRating', op: 'gte', value: '60' },
  ] }],
  action: 'colorize', color: '#123456',
};

describe('Lens FilterGroup editor (#5896)', () => {
  it('renders a canonical FilterGroup editor for an AND rule with a numeric comparison', async () => {
    const { container } = await render(baseRule);
    assert.match(container.textContent ?? '', /Filter groups|Group 1|AND/i);
    assert.ok(container.querySelector('select'), 'canonical group editor provides controls');
    assert.equal(container.querySelector('[role="alert"]'), null);
  });

  it('keeps an unreadable legacy criterion visible until the user explicitly replaces it', async () => {
    const legacy = { type: 'material', materialName: 'Concrete' };
    const { container, onChange } = await render({
      ...baseRule, groups: [], unreadableLegacy: { criteria: legacy, reason: 'No exact mapping' },
    });
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /No exact mapping/);
    assert.equal(onChange.mock.callCount(), 0);
    const button = [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.includes('Replace condition'));
    assert.ok(button);
    act(() => button.click());
    assert.equal(onChange.mock.callCount(), 1);
    assert.deepEqual(onChange.mock.calls[0].arguments[0], {
      groups: [{ combinator: 'AND', rules: [] }], unreadableLegacy: undefined,
    });
  });
});
