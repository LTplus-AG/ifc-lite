/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Properties panel's Split button answers from the same predicate the
 * split commit uses (#6233). It used to probe the wall / linear / slab
 * readers itself: it offered Split on a freshly authored wall in a
 * millimetre file (which the commit then refused) and silently vanished for
 * the demo's imported walls. Now it is always shown, enabled exactly when
 * `readSplitTarget` accepts the element, and disabled with the reason
 * otherwise.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { MESH_WALL, MODEL_ID as SPLIT_MODEL_ID, STOREY as SPLIT_STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { getCommandRuntime } from '@/lib/commands/modeling/runtime';
import { GeometryEditCard } from './GeometryEditCard.js';

function splitButton(ui: HTMLElement): HTMLButtonElement {
  const button = [...ui.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Split');
  assert.ok(button, 'the Split button is always rendered');
  return button;
}

describe('GeometryEditCard Split availability (#6233)', () => {
  beforeEach(() => seedModelingSession({ unit: 'millimetre' }));
  afterEach(() => {
    cleanup();
    useViewerStore.getState().exitModelWorkspace();
  });

  it('enables Split for a wall just authored in a millimetre file, and starts element.split on it', () => {
    const wall = useViewerStore.getState().addWall(SPLIT_MODEL_ID, SPLIT_STOREY, {
      Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 2.5,
    });
    assert.ok('expressId' in wall);
    const s = useViewerStore.getState();
    s.setSelectedEntityId(toGlobalIdFromModels(s.models, SPLIT_MODEL_ID, wall.expressId));
    const ui = render(<GeometryEditCard modelId={SPLIT_MODEL_ID} entityId={wall.expressId} />);
    const button = splitButton(ui);
    assert.equal(button.disabled, false);
    click(button);
    const runtime = getCommandRuntime();
    assert.equal(runtime.command?.id, 'element.split');
    assert.deepEqual((runtime.gesture as { target: unknown }).target, { modelId: SPLIT_MODEL_ID, expressId: wall.expressId });
  });

  it('shows a disabled Split with the reason for an imported mesh-bodied wall', () => {
    const ui = render(<GeometryEditCard modelId={SPLIT_MODEL_ID} entityId={MESH_WALL} />);
    const button = splitButton(ui);
    assert.equal(button.disabled, true);
    // The disabled button gets no pointer events; its focusable wrapper
    // carries the tooltip that names why.
    const trigger = button.parentElement;
    assert.ok(trigger);
    act(() => trigger.focus());
    assert.match(document.body.textContent ?? '', /the geometry is a mesh or B-rep, not a profile extrusion/);
  });
});
