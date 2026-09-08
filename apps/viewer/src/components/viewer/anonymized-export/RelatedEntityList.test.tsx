/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `RelatedEntityList`'s section-header checkbox: `indeterminate` is a
 * DOM-only property with no React attribute, so a naive ref CALLBACK that
 * only reruns on mount/remount goes stale on an ordinary re-render — the
 * header would keep showing "all included" after one row of a fully-checked
 * group gets unchecked. Regression test for that; does not touch the parser
 * or the viewer store, since `RelatedEntityList` takes its `related` set as
 * a plain prop.
 */

import '@/test/setup-dom.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import type { RelatedEntities } from '@ifc-lite/export';
import { RelatedEntityList } from './RelatedEntityList.js';

const RELATED: RelatedEntities = {
  seeds: [1],
  groups: [
    {
      relationship: 'IfcRelAggregates',
      role: 'part',
      expressIds: [2, 3],
      relationshipIds: [99],
    },
  ],
  all: new Set([1, 2, 3, 99]),
  truncated: false,
};

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(node: ReactNode): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(node); });
  mounted.push({ root, container });
  return container;
}
function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}
after(unmountAll);

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/** Controlled wrapper mirroring how `AnonymizedExportDialog` owns exclusion
 *  state — `RelatedEntityList` itself is a pure display component. */
function Harness() {
  const [excludedIds, setExcludedIds] = useState<Set<number>>(new Set());
  return (
    <RelatedEntityList
      dataStore={null}
      seeds={RELATED.seeds}
      related={RELATED}
      excludedIds={excludedIds}
      lockedIds={new Set(RELATED.seeds)}
      onSetExcluded={(id, excluded) => {
        setExcludedIds((prev) => {
          const next = new Set(prev);
          if (excluded) next.add(id); else next.delete(id);
          return next;
        });
      }}
    />
  );
}

function groupHeaderCheckbox(): HTMLInputElement {
  const el = document.body.querySelector('input[aria-label="Toggle all IfcRelAggregates (part)"]');
  assert.ok(el, 'no group header checkbox');
  return el as HTMLInputElement;
}

function itemCheckbox(id: number): HTMLInputElement {
  const labels = [...document.body.querySelectorAll('label')];
  const label = labels.find((l) => l.textContent?.includes(`#${id}`));
  assert.ok(label, `no checkbox row for #${id}`);
  return label.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

describe('RelatedEntityList — section header indeterminate state', () => {
  it('goes indeterminate immediately when one row of a fully-checked group is unchecked, without unmounting', () => {
    render(<Harness />);

    const header = groupHeaderCheckbox();
    assert.equal(header.checked, true, 'starts fully checked');
    assert.equal(header.indeterminate, false, 'starts fully checked, not mixed');

    // Uncheck one (non-locked) row of the group — same mounted tree, no
    // remount, so a ref-callback-only fix would leave this stale.
    click(itemCheckbox(2));

    assert.equal(header.checked, false, 'header must stop reporting fully-checked');
    assert.equal(header.indeterminate, true, 'mixed state must show as indeterminate on the SAME render pass, not after a remount');

    // Re-check it — indeterminate must clear again just as live.
    click(itemCheckbox(2));
    assert.equal(header.indeterminate, false, 'clears back to a clean fully-checked state');
    assert.equal(header.checked, true);
  });
});
