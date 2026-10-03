/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';
import { recordSessionMutation } from './session-history.js';
import { recordCompoundMutation, undoRecordedMutationOperations } from './compound-recording.js';
import { changeSetToOps } from './change-set-to-ops.js';

it('session markers preserve IFC graph, allocation and replay while participating in compound Undo (#6758)', () => {
  const view = new MutablePropertyView(null, 'm'), next = view.peekNextExpressId();
  const marker = recordCompoundMutation(view, draft => recordSessionMutation(draft, 42, 'room-layout'));
  expect(view.getMutations()).toEqual([marker]);
  expect(marker.modelId).toBe('m');
  expect(view.getEffectiveChanges()).toEqual([]);
  expect(view.hasPendingChanges()).toBe(false);
  expect(view.peekNextExpressId()).toBe(next);
  const exported = changeSetToOps({ id: 'local', name: 'Room layout', createdAt: 0, applied: false, mutations: [marker] }, {
    globalIdOf: () => { throw new Error('Session markers must not resolve IFC entities'); },
  });
  expect(exported).toEqual({ ops: [], identityMap: [], unresolved: [], skipped: [] });
  const imported = new MutablePropertyView(null, 'peer');
  imported.applyMutations([marker]);
  expect(imported.getMutations()).toEqual([]);
  expect(imported.getEffectiveChanges()).toEqual([]);
  expect(undoRecordedMutationOperations(view, 1, () => { throw new Error('Session marker must use compound inverse'); })).toBe(1);
  expect(view.getMutations()).toEqual([]);
  expect(view.getEffectiveChanges()).toEqual([]);
  expect(view.peekNextExpressId()).toBe(next);
  expect(() => recordCompoundMutation(view, draft => { recordSessionMutation(draft, 42, 'room-layout'); throw new Error('later refusal'); })).toThrow('later refusal');
  expect(view.getMutations()).toEqual([]);
});
