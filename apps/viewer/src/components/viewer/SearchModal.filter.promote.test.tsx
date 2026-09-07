/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Add <query> as rule" in the Filter tab now reads the search bar as a
 * selector when the whole thing maps cleanly, and keeps the historical
 * `Name contains` otherwise (#4091).
 *
 * The fallback is the half worth pinning: a partial selector reading would
 * drop the part it could not carry, which is the silent-empty-result shape
 * this change exists to remove.
 */

import '@/test/setup-dom.js';

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup, click } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { Rule } from '@/lib/search/filter-rules';
import { SearchModalFilterBuilder } from './SearchModal.filter.builder.js';

function mountWithQuery(searchQuery: string): HTMLElement {
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m1'), schemaVersion: 'IFC4' }),
    searchQuery,
    searchFilter: { rules: [], combinator: 'AND', limit: 500 },
  });
  return render(<SearchModalFilterBuilder />);
}

function promote(container: HTMLElement): void {
  const button = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('as rule'),
  );
  assert.ok(button, 'no "add as rule" button rendered');
  click(button);
}

const rules = () => useViewerStore.getState().searchFilter.rules;

describe('Filter tab — promoting the search bar query', () => {
  afterEach(cleanup);

  it('a class name becomes an expanded type rule, not a Name contains', () => {
    const container = mountWithQuery('IfcWall');
    promote(container);
    assert.deepEqual(rules(), [
      Rule.ifcType(['IfcWall', 'IfcWallElementedCase', 'IfcWallStandardCase'], 'in'),
    ]);
  });

  it('a full selector becomes every rule it means', () => {
    const container = mountWithQuery('IfcDoor, Name=/D[0-9]{2}/');
    promote(container);
    assert.deepEqual(rules(), [
      Rule.ifcType(['IfcDoor', 'IfcDoorStandardCase'], 'in'),
      Rule.name('matches', 'D[0-9]{2}', 'regex'),
    ]);
  });

  it('plain text that is not a selector keeps the Name contains it always was', () => {
    const container = mountWithQuery('Wand');
    promote(container);
    assert.deepEqual(rules(), [Rule.name('contains', 'Wand')]);
  });

  it('a selector the adapter cannot fully carry falls back rather than dropping a part', () => {
    const container = mountWithQuery('IfcWall, type=WT01');
    promote(container);
    assert.deepEqual(rules(), [Rule.name('contains', 'IfcWall, type=WT01')]);
  });
});
