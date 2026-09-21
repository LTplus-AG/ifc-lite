/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The rule editor's selector mode reuses `SelectorTextEditor` (#5138 PR 5,
 * lifted from `SearchModal.filter.selector.tsx`, #4091's "never apply a
 * partial reading silently" posture): a selector construct the adapter
 * cannot map to a rule — `query:` is refused permanently — shows the
 * adapter's own message and leaves the block's `groups` UNCHANGED, which
 * is what "blocks Save" means for a controlled editor with no persistence
 * of its own (Save lives in the eventual `ValidationPanel`, PR 4): nothing
 * ever reaches `onChange` for the caller to persist.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { render, cleanup, click, type } from '@/test/render.js';
import type { RuleBlock } from '@/lib/validation/rule-set';
import { RuleBlockEditor } from './RuleBlockEditor.js';

function emptyBlock(): RuleBlock {
  return { groups: [{ rules: [{ kind: 'name', op: 'contains', value: 'Wall' }], combinator: 'AND' }], authoredAs: 'selector' };
}

function Harness({ onBlockChange }: { onBlockChange?: (b: RuleBlock) => void }) {
  const [block, setBlock] = useState(emptyBlock());
  return (
    <RuleBlockEditor
      block={block}
      onChange={(next) => { setBlock(next); onBlockChange?.(next); }}
      models={[]}
    />
  );
}

function selectorInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input[aria-label="Selector syntax"]');
  assert.ok(el instanceof window.HTMLInputElement, 'no selector input rendered — is the block in selector mode?');
  return el as HTMLInputElement;
}

function applyButton(container: HTMLElement): HTMLElement {
  const el = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Apply'));
  assert.ok(el, 'no Apply button rendered');
  return el!;
}

describe('RuleBlockEditor — selector mode rejects an unsupported construct (#5138)', () => {
  afterEach(cleanup);

  it('typing an unsupported selector construct shows the adapter message and leaves groups unchanged', () => {
    let latest: RuleBlock | undefined;
    const container = render(<Harness onBlockChange={(b) => { latest = b; }} />);

    // Already in selector mode (`emptyBlock`'s `authoredAs`); the field is
    // present without needing a mode-toggle click.
    type(selectorInput(container), 'query:types.count=0');
    click(applyButton(container));

    assert.equal(latest, undefined, 'onChange must not fire for a query that maps to no rule');
    const alert = container.querySelector('[role="alert"]');
    assert.ok(alert, 'expected the adapter’s error/warning list to render');
    assert.match(alert!.textContent ?? '', /query:types\.count=0/);
  });

  it('a selector that DOES parse still applies through the same mode', () => {
    let latest: RuleBlock | undefined;
    const container = render(<Harness onBlockChange={(b) => { latest = b; }} />);

    type(selectorInput(container), 'IfcWall');
    click(applyButton(container));

    assert.ok(latest);
    assert.equal(latest!.groups.length, 1);
    assert.equal(latest!.groups[0].rules[0]?.kind, 'ifcType');
  });
});
