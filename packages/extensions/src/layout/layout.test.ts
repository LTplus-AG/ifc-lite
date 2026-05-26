/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { BUILTIN_PANEL_IDS, createDefaultWorkbenchLayout, mergeWorkbenchLayouts, normalizeWorkbenchLayout } from './index.js';

describe('workbench layout normalization', () => {
  it('defaults legacy empty layout state', () => {
    const layout = normalizeWorkbenchLayout({});
    expect(layout.schemaVersion).toBe(1);
    expect(layout.zones.left).toEqual([BUILTIN_PANEL_IDS.hierarchy]);
  });

  it('keeps valid user panel order and clamps bottom height', () => {
    const layout = normalizeWorkbenchLayout({
      schemaVersion: 1,
      zones: { left: ['a', 'a', 'b'], right: [], bottom: [] },
      sizes: { horizontal: [25, 50, 25], bottomHeight: 9999 },
    });
    expect(layout.zones.left).toEqual(['a', 'b']);
    expect(layout.sizes.horizontal).toEqual([25, 50, 25]);
    expect(layout.sizes.bottomHeight).toBe(1200);
  });
});

describe('mergeWorkbenchLayouts', () => {
  it('takes one-sided panel moves without conflict', () => {
    const base = createDefaultWorkbenchLayout();
    const theirs = createDefaultWorkbenchLayout();
    const ours = createDefaultWorkbenchLayout();
    ours.zones.left = [...ours.zones.left, BUILTIN_PANEL_IDS.bcf];
    ours.zones.right = ours.zones.right.filter((id) => id !== BUILTIN_PANEL_IDS.bcf);
    const result = mergeWorkbenchLayouts(base, theirs, ours);
    expect(result.conflicts).toEqual([]);
    expect(result.merged.zones.left).toContain(BUILTIN_PANEL_IDS.bcf);
  });

  it('surfaces conflicting panel moves', () => {
    const base = createDefaultWorkbenchLayout();
    const theirs = createDefaultWorkbenchLayout();
    const ours = createDefaultWorkbenchLayout();
    theirs.zones.bottom = [...theirs.zones.bottom, BUILTIN_PANEL_IDS.bcf];
    theirs.zones.right = theirs.zones.right.filter((id) => id !== BUILTIN_PANEL_IDS.bcf);
    ours.zones.left = [...ours.zones.left, BUILTIN_PANEL_IDS.bcf];
    ours.zones.right = ours.zones.right.filter((id) => id !== BUILTIN_PANEL_IDS.bcf);
    const result = mergeWorkbenchLayouts(base, theirs, ours);
    expect(result.conflicts.some((c) => c.kind === 'panel_move')).toBe(true);
  });
});
