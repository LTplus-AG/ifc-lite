/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The list builder's model tag scope editor (issue #4215), mounted: the
 * operators read as they do in the advanced filter, a chosen scope is
 * summarised under the select so a saved list shows what it is restricted
 * to, and a tag the scope names but that no longer exists is drawn, not hidden.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';

installLayout();

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ListModelTagScope } from '@ifc-lite/lists';
import { render, cleanup, click } from '@/test/render.js';
import { registerLocale, setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { ListModelTagScopeEditor } from './ListModelTagScopeEditor.js';

// `lists.*` keys resolve straight off `en.ts`'s own registration now
// (#4918 integration pass) — no per-test catalogue merge needed.

let structure = '';
let mep = '';

function seed(): void {
  useViewerStore.setState({ models: new Map(), modelTags: new Map(), modelTagAssignments: new Map() });
  const s = useViewerStore.getState();
  structure = s.createModelTag('Structure')!;
  mep = s.createModelTag('MEP')!;
}

function mount(value: ListModelTagScope | undefined) {
  const changes: (ListModelTagScope | undefined)[] = [];
  const container = render(<ListModelTagScopeEditor value={value} onChange={(next) => changes.push(next)} />);
  return { container, changes };
}

const optionLabels = (root: ParentNode) => [...root.querySelectorAll<HTMLOptionElement>('select option')].map((o) => o.textContent);
const hint = (root: ParentNode) => root.querySelector('[data-list-model-tag-scope-hint]')?.textContent ?? null;

describe('ListModelTagScopeEditor (#4215)', () => {
  beforeEach(seed);
  afterEach(cleanup);

  it('offers the four predicates in the advanced filter\'s own words, after "all models"', () => {
    const { container } = mount(undefined);
    assert.deepEqual(optionLabels(container), ['all models', 'has any of', 'has all of', 'has none of', 'is untagged']);
    assert.equal(hint(container), null, 'no scope, nothing to summarise');
  });

  it('summarises the chosen scope under the select, and says when no tag is picked yet', () => {
    const empty = mount({ op: 'hasAny', tagIds: [] });
    assert.equal(hint(empty.container), null);
    assert.match(empty.container.textContent ?? '', /Pick at least one tag/);
    cleanup();

    const { container, changes } = mount({ op: 'hasAll', tagIds: [structure, mep] });
    assert.equal(hint(container), 'Runs over models that have all of Structure, MEP.');
    click([...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith('MEP'))!);
    assert.deepEqual(changes, [{ op: 'hasAll', tagIds: [structure] }], 'toggling a chip narrows the scope by id');
    cleanup();

    assert.equal(hint(mount({ op: 'untagged', tagIds: [] }).container), 'Runs over untagged models.');
  });

  it('draws a tag the scope names but that no longer exists, with the refusal spelled out', () => {
    const { container } = mount({ op: 'hasAny', tagIds: [structure, 'tag-gone'] });
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? '', /no longer exists/);
    assert.ok(container.querySelector('[data-model-tag-chip][data-unresolved]'), 'the stale reference is visible so it can be removed');
  });
});

/**
 * Revert-oracle witness (#4918): the sibling assertions above compare
 * against the DEFAULT English text, which is identical whether it comes
 * from a hardcoded string or from `t()` resolving the 'en' locale — so
 * they cannot tell a real translation call from a coincidentally-matching
 * literal. This registers a pseudo locale and switches to it, which only a
 * real `t()` call responds to, using only pre-existing public `@/i18n` API
 * (no import of the `lists.en.ts` catalogue module, so a revert that
 * deletes that brand-new file does not break this file's LOAD).
 */
describe('ListModelTagScopeEditor is localized (#4918 revert-oracle witness)', () => {
  beforeEach(seed);
  afterEach(() => {
    cleanup();
    setLocale('en');
  });

  it('renders a registered locale override for the operator select and the "Runs over" hint', () => {
    registerLocale('list-model-tag-scope-witness', {
      'filterOperators.hasAll': 'WITNESS-HAS-ALL',
      'lists.modelTagScope.runsOverHasAll': 'WITNESS-RUNS-OVER {names}',
    });
    setLocale('list-model-tag-scope-witness');
    const { container } = mount({ op: 'hasAll', tagIds: [structure, mep] });
    assert.deepEqual(
      optionLabels(container).includes('WITNESS-HAS-ALL'),
      true,
      'operator select must come from the active locale, not a hardcoded "has all of" string',
    );
    assert.equal(
      hint(container),
      'WITNESS-RUNS-OVER Structure, MEP',
      '"Runs over" hint must come from the active locale, not a hardcoded description',
    );
  });
});
