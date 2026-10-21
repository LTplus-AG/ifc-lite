/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Matched results stay bounded in the DOM and reachable beyond 1,000 (#8017). */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
installLayout();
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CompareMatchRow } from './changeRow.js';
import { CompareMatchGroups } from './CompareMatchGroups.js';

/** `retiring: true` rows are the Matched section; `false` rows belong to Suggestions. */
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

describe('CompareMatchGroups - virtual rows (#8017)', () => {
  it('renders every row when the group is under the cap', () => {
    const container = render(rows(3, true));
    assert.strictEqual(rowButtons(container).length, 3);
    assert.ok(!container.textContent?.includes('more not shown'));
  });

  it('caps the rendered rows of a huge Matched group', () => {
    // The default-on re-export case. Pre-fix this rendered one button per
    // match, unbounded.
    const container = render(rows(1007, true));
    assert.ok(rowButtons(container).length > 0 && rowButtons(container).length < 100);
  });

  it('reaches the last matched row by scrolling beyond the old cap (#8017)', () => {
    const container = render(rows(1007, true));
    const scroller = container.querySelector('.overflow-auto')!;
    act(() => {
      scroller.scrollTop = 1006 * 800;
      scroller.dispatchEvent(new Event('scroll'));
    });
    assert.ok(rowButtons(container).some((button) => button.textContent?.includes('Wall 1006')));
    assert.ok(!container.textContent?.includes('more not shown'));
  });

  it('keeps the header count at the FULL group size, not the rendered size', () => {
    const container = render(rows(1007, true));
    const header = container.querySelector('button');
    assert.ok(header);
    assert.ok(
      header.textContent?.includes(`(${1007})`),
      `header read "${header.textContent}"`,
    );
  });

  it('still selects every element in the group, including the unrendered ones', () => {
    // The Added/Changed/Deleted headers select the full bucket rather than the
    // capped rows; a capped match header that only selected what it drew would
    // quietly disagree with its own count.
    let selected: CompareMatchRow[] = [];
    const container = render(rows(1007, true), (r) => {
      selected = r;
    });
    act(() => {
      container.querySelector('button')!.click();
    });
    assert.strictEqual(selected.length, 1007);
  });

  it('does not list an unresolved group here: those are Suggestions (#4955)', () => {
    // Unresolved groups retire nothing, so they were listed here AND under
    // Added/Deleted. Since #4955 they are offered for a decision in the
    // Suggestions section instead; a second listing here would be the flood
    // the cap exists to prevent, twice.
    const container = render(rows(3, false));
    assert.strictEqual(container.querySelectorAll('button').length, 0);
  });
});
