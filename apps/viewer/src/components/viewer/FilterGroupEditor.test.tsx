/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FilterGroupEditor`'s own group-removal nuances, driven through rendered
 * output (#5138 PR 5). `addFilterGroup`/`removeFilterGroup` — the store
 * actions `SearchModal.filter.groups.test.tsx` used to exercise this
 * through — were deleted once `FilterGroupEditor.tsx` became their only
 * caller's replacement (supersede = delete); these two invariants moved
 * here rather than disappearing with them:
 *
 *  - removing a PRECEDING group keeps the SAME logical group active,
 *    rather than re-clamping the stale numeric index onto whatever group
 *    slid into it (review, PR #4987, originally pinned in
 *    `searchSlice.test.ts`).
 *  - removing the ACTIVE group itself picks a neighbour.
 *
 * `SearchModal.filter.groups.test.tsx` still covers the simpler cases (one
 * group renders no tabs, "Add group" appends and activates, a rule lands
 * in whichever group is active) unchanged — this file only adds the
 * multi-group removal nuance that file never exercised.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { render, cleanup, click } from '@/test/render.js';
import type { FilterGroup } from '@ifc-lite/rules';
import { FilterGroupEditor, type FilterGroupEditorState } from './FilterGroupEditor.js';

function groupNamed(name: string): FilterGroup {
  return { rules: [{ kind: 'ifcType', values: [name], op: 'in' }], combinator: 'AND' };
}

function Harness({ onState }: { onState: (s: FilterGroupEditorState) => void }) {
  const [state, setState] = useState<FilterGroupEditorState>({
    groups: [groupNamed('A'), groupNamed('B'), groupNamed('C')],
    activeGroup: 1, // "B"
  });
  return (
    <FilterGroupEditor
      groups={state.groups}
      activeGroup={state.activeGroup}
      onChange={(updater) => {
        const next = updater(state);
        setState(next);
        onState(next);
      }}
      models={[]}
    />
  );
}

function removeGroupButton(container: HTMLElement, index: number): HTMLElement {
  const el = container.querySelector(`button[aria-label="Remove group ${index}"]`);
  assert.ok(el, `no "Remove group ${index}" button rendered`);
  return el as HTMLElement;
}

const activeName = (state: FilterGroupEditorState): string => {
  const rule = state.groups[state.activeGroup].rules[0];
  return rule.kind === 'ifcType' ? rule.values[0] : '?';
};

describe('FilterGroupEditor — group removal nuances (#5138, #4987)', () => {
  afterEach(cleanup);

  it('removing a PRECEDING group keeps the SAME logical group active, not a re-clamped index', () => {
    let latest: FilterGroupEditorState | undefined;
    const container = render(<Harness onState={(s) => { latest = s; }} />);

    // A/B/C, B active (index 1). Removing A (index 1 in the 1-based UI
    // label) must land on B, now at index 0 — not silently re-clamp to
    // whatever slid into the old numeric index 1 (C).
    click(removeGroupButton(container, 1));

    assert.ok(latest);
    assert.equal(latest!.groups.length, 2);
    assert.equal(latest!.activeGroup, 0);
    assert.equal(activeName(latest!), 'B');
  });

  it('removing the ACTIVE group itself picks a neighbour', () => {
    let latest: FilterGroupEditorState | undefined;
    const container = render(<Harness onState={(s) => { latest = s; }} />);

    // B is active (index 1); remove B itself via its own "Remove group 2"
    // button. Neither A nor C is "preceding" B's own removal, so the
    // neighbour that slides into index 1 (C) takes over — the numeric
    // index is what stays fixed here, unlike the preceding-removal case.
    click(removeGroupButton(container, 2));

    assert.ok(latest);
    assert.equal(latest!.groups.length, 2);
    assert.equal(latest!.activeGroup, 1);
    assert.equal(activeName(latest!), 'C');
  });
});
