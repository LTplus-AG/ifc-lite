/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every registry panel has a body, and a title to put above it.
 *
 * The mobile bottom sheet used to hand-write an if-chain over the panels it
 * knew — seven of them — and fall through to `<PropertiesPanel />` for the
 * rest. Compare, Clash, Cloud sources, the Layer stack, Location zones and the
 * collab Room all opened on a phone as the Properties panel, titled
 * "Properties": the wrong panel, not merely a wrong label. Nothing failed,
 * because a fall-through branch is indistinguishable from an intended one.
 *
 * The sheet now renders through `renderPanelBody`, the same map the sidebar,
 * the floating host and the pop-out windows use, and titles from the registry.
 * That closes the gap for today's panels; these tests are what stop the NEXT
 * panel from re-opening it, since a new registry entry with no `renderPanelBody`
 * case returns undefined rather than failing to compile.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_PANELS, getPanelDef } from './registry.js';
import { renderPanelBody } from './renderPanelBody.js';

describe('workspace panel registry coverage', () => {
  it('renders a body for every registered panel', () => {
    const missing = WORKSPACE_PANELS
      .filter((panel) => renderPanelBody(panel.id, () => {}) == null)
      .map((panel) => panel.id);

    assert.deepEqual(
      missing,
      [],
      'these panels render nothing — every host (sidebar, float, pop-out, mobile sheet) would show a blank pane',
    );
  });

  it('renders a DISTINCT body per panel, so none silently falls through to another', () => {
    // The defect was a fall-through, so identity is the property under test:
    // two ids resolving to the same component is how Compare came out as
    // Properties. Compares the element TYPE, which is the component function.
    const byType = new Map<unknown, string[]>();
    for (const panel of WORKSPACE_PANELS) {
      const body = renderPanelBody(panel.id, () => {}) as { type?: unknown } | null;
      const type = body?.type;
      if (type === undefined) continue;
      const ids = byType.get(type) ?? [];
      ids.push(panel.id);
      byType.set(type, ids);
    }

    const shared = [...byType.values()].filter((ids) => ids.length > 1);
    assert.deepEqual(shared, [], 'these panel ids render the same component — one is showing the other\'s panel');
  });

  it('gives every registered panel a title for the sheet header', () => {
    const untitled = WORKSPACE_PANELS
      .filter((panel) => !getPanelDef(panel.id)?.title)
      .map((panel) => panel.id);

    assert.deepEqual(untitled, [], 'these panels would head the mobile sheet with a blank title');
  });
});
