/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Model workspace's one-time hint (#6232 M2.1) retires on THIS user's
 * first edit in the workspace, never on a collaborator's. It used to retire
 * on any `mutationVersion` bump, so a peer's edit hid it for good from a user
 * who had drawn nothing (#6315 review).
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { PropertyValueType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { cleanup, render } from '@/test/render.js';
import { MODEL_ID, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { commandPointerDown, commandPointerMove } from '@/lib/commands/modeling/runtime';
import type { SnapResult } from '@/lib/snap/types';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { ModelOnboardingHint } from './ModelOnboardingHint';

const SEEN_KEY = 'ifc-lite:model-hint-seen';
const hint = () => document.querySelector('[data-model-onboarding-hint]');
const at = (x: number, y: number): SnapResult => ({ local: [x, y], winner: null, guides: [], locked: false });
const click = (x: number, y: number) => { commandPointerMove(at(x, y)); commandPointerDown(at(x, y)); };

/** A collaborator's property write, applied the way `collabSlice`'s remote
 *  `onProperty` handler applies one: straight to the view (no undo entry),
 *  clearing stale local history for the entity, then bumping `mutationVersion`. */
function applyRemotePropertyWrite(entityId: number): void {
  const s = useViewerStore.getState();
  s.mutationViews.get(MODEL_ID)!.setProperty(entityId, 'Pset_Remote', 'Status', 'peer', PropertyValueType.Label);
  s.invalidateHistoryForEntity(MODEL_ID, entityId);
  useViewerStore.setState((st) => ({ mutationVersion: st.mutationVersion + 1 }));
}

beforeEach(async () => {
  globalThis.localStorage.removeItem(SEEN_KEY);
  await seedModelingSession();
});
afterEach(() => {
  cleanup();
  useViewerStore.getState().exitModelWorkspace();
  globalThis.localStorage.removeItem(SEEN_KEY);
});

describe('ModelOnboardingHint (#6232 M2.1)', () => {
  it('stays up through a collaborator\'s edit, and retires on this user\'s first committed wall', () => {
    render(<ViewportHud />);
    render(<ModelOnboardingHint />);
    act(() => { if (useViewerStore.getState().workspaceMode !== 'model') useViewerStore.getState().enterModelWorkspace(); });
    act(() => { useViewerStore.getState().setActiveTool('select'); });
    assert.equal(useViewerStore.getState().workspaceMode, 'model');
    assert.ok(hint(), 'the hint shows while Select is the tool');

    const versionBefore = useViewerStore.getState().mutationVersion;
    const wall = [...useViewerStore.getState().models.get(MODEL_ID)!.ifcDataStore!.entityIndex.byType.get('IFCWALL') ?? []][0] ?? 1;
    act(() => { applyRemotePropertyWrite(wall); });
    assert.notEqual(useViewerStore.getState().mutationVersion, versionBefore, 'the remote edit did bump mutationVersion');
    assert.ok(hint(), 'a collaborator\'s edit does not retire the hint');
    assert.equal(globalThis.localStorage.getItem(SEEN_KEY), null);

    act(() => { useViewerStore.getState().startCommand('wall.place'); });
    act(() => { click(0, 0); click(4, 0); });
    act(() => { useViewerStore.getState().endCommand('cancel'); useViewerStore.getState().setActiveTool('select'); });
    assert.equal(hint(), null, 'the user\'s own committed wall retires the hint');
    assert.equal(globalThis.localStorage.getItem(SEEN_KEY), '1', 'retired for good');
  });
});
