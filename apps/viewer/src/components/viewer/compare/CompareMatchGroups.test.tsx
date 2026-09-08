/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Row cap on the content-match sections (#1891 review, Codex P1).
 *
 * The Added / Changed / Deleted buckets have been capped at
 * `MAX_ROWS_PER_GROUP` since #924; the Matched / Needs review sections shipped
 * uncapped. That is the worse place for it to be missing: content matching is
 * ON by default and a from-scratch re-export produces roughly one match record
 * per element, so the headline scenario - the one the whole feature exists for
 * - is the one that pushes tens of thousands of buttons into the DOM and stalls
 * the panel.
 *
 * The cap is display-only, and these tests pin all three halves of that: the
 * button count, the reported overflow (a silently-shown subset would be worse
 * than a slow one), and that the header count plus the header's "select all in
 * 3D" action still cover the FULL set - matching how the other groups behave.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MAX_ROWS_PER_GROUP, type CompareMatchRow } from './changeRow.js';
import { CompareMatchGroups } from './CompareMatchGroups.js';

/** `retiring` picks the section: true -> Matched, false -> Needs review. */
function rows(count: number, retiring: boolean): CompareMatchRow[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `match:${i}`,
    kind: retiring ? ('renamed' as const) : ('ambiguous' as const),
    retiring,
    ifcType: 'IfcWall',
    name: `Wall ${i}`,
    baseCount: 1,
    headCount: 1,
    refs: [{ modelId: 'B', localId: i, globalId: 1000 + i }],
  }));
}

const mounted: Root[] = [];

function render(matchRows: CompareMatchRow[], onFocusGroup: (r: CompareMatchRow[]) => void = () => {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);
  act(() => {
    root.render(
      <CompareMatchGroups
        rows={matchRows}
        selectedKey={null}
        onFocus={() => {}}
        onFocusGroup={onFocusGroup}
      />,
    );
  });
  return container;
}

afterEach(() => {
  let root = mounted.pop();
  while (root) {
    const current = root;
    act(() => current.unmount());
    root = mounted.pop();
  }
});

/** Section header + one button per listed row, so the row buttons are the
 *  buttons after the header. */
function rowButtons(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].slice(1) as HTMLButtonElement[];
}

describe('CompareMatchGroups - row cap (#1891 review)', () => {
  it('renders every row when the group is under the cap', () => {
    const container = render(rows(3, true));
    assert.strictEqual(rowButtons(container).length, 3);
    assert.ok(!container.textContent?.includes('more not shown'));
  });

  it('caps the rendered rows of a huge Matched group', () => {
    // The default-on re-export case. Pre-fix this rendered one button per
    // match, unbounded.
    const container = render(rows(MAX_ROWS_PER_GROUP + 7, true));
    assert.strictEqual(rowButtons(container).length, MAX_ROWS_PER_GROUP);
  });

  it('reports the truncated remainder rather than dropping it silently', () => {
    const container = render(rows(MAX_ROWS_PER_GROUP + 7, true));
    assert.ok(
      container.textContent?.includes('+7 more not shown'),
      'must use the same overflow wording as the Added/Changed/Deleted groups',
    );
  });

  it('keeps the header count at the FULL group size, not the rendered size', () => {
    const container = render(rows(MAX_ROWS_PER_GROUP + 7, true));
    const header = container.querySelector('button');
    assert.ok(header);
    assert.ok(
      header.textContent?.includes(`(${MAX_ROWS_PER_GROUP + 7})`),
      `header read "${header.textContent}"`,
    );
  });

  it('still selects every element in the group, including the unrendered ones', () => {
    // The Added/Changed/Deleted headers select the full bucket rather than the
    // capped rows; a capped match header that only selected what it drew would
    // quietly disagree with its own count.
    let selected: CompareMatchRow[] = [];
    const container = render(rows(MAX_ROWS_PER_GROUP + 7, true), (r) => {
      selected = r;
    });
    act(() => {
      container.querySelector('button')!.click();
    });
    assert.strictEqual(selected.length, MAX_ROWS_PER_GROUP + 7);
  });

  it('caps the Needs review section too', () => {
    // Unresolved groups retire nothing, so they are listed here AND under
    // Added/Deleted - an uncapped section here doubles the flood.
    const container = render(rows(MAX_ROWS_PER_GROUP + 4, false));
    assert.strictEqual(rowButtons(container).length, MAX_ROWS_PER_GROUP);
    assert.ok(container.textContent?.includes('+4 more not shown'));
  });

  it('caps the two sections independently', () => {
    const container = render([
      ...rows(MAX_ROWS_PER_GROUP + 2, true),
      ...rows(MAX_ROWS_PER_GROUP + 5, false).map((r) => ({ ...r, key: `${r.key}:review` })),
    ]);
    // Two section headers + the capped rows of each.
    assert.strictEqual(container.querySelectorAll('button').length, 2 + MAX_ROWS_PER_GROUP * 2);
    assert.ok(container.textContent?.includes('+2 more not shown'));
    assert.ok(container.textContent?.includes('+5 more not shown'));
  });
});
