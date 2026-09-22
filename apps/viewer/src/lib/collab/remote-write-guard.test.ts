/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import {
  applyRemoteProperty,
  applyRemotePropertyDelete,
  applyRemotePsetDelete,
} from './remote-write-guard.js';

/**
 * Sibling to `mutation-bridge.tombstone.test.ts`, which pins the guard for
 * `applyRemoteAttribute`. This file pins the same guard for the other three
 * `applyRemote*` helpers (#5187): `onProperty`, `onPropertyDelete` and
 * `onPsetDelete` called `MutablePropertyView.setProperty` /
 * `deleteProperty` / `deletePropertySet` directly, with no tombstone check
 * of their own, so a remote write accepted while the local entity was
 * deleted survived a later `restoreFromTombstone` and came back live —
 * executed and confirmed on the issue:
 *
 *   deleteEntity(42)                                        -> true
 *   getPropertyValue(42, Pset_Remote, Status) while deleted -> LIVE_FROM_PEER
 *   restoreFromTombstone(42)                                -> true
 *   getPropertyValue(42, Pset_Remote, Status) after restore -> LIVE_FROM_PEER
 *
 * All three helpers now route through `remote-write-guard.ts`'s single
 * `rejectIfLocallyDeleted` check (the same one `applyRemoteAttribute` uses),
 * so a mutation of any ONE handler's guard reddens only that handler's test
 * below, not the others' — see the mutation table in the PR/issue writeup.
 */

describe('applyRemoteProperty refuses a write to a locally tombstoned entity', () => {
  it('rejects instead of recording the write, and the property is not live after restoreFromTombstone', () => {
    const view = new MutablePropertyView(null, 'room-model');
    view.deleteEntity(42);

    const reason = applyRemoteProperty(view, 42, 'Pset_Remote', 'Status', 'LIVE_FROM_PEER', PropertyValueType.Label);

    assert.strictEqual(reason, 'entity 42 is locally deleted');
    assert.strictEqual(view.getPropertyValue(42, 'Pset_Remote', 'Status'), null);

    view.restoreFromTombstone(42);

    assert.strictEqual(view.isDeleted(42), false);
    assert.strictEqual(view.getPropertyValue(42, 'Pset_Remote', 'Status'), null);
  });

  it('still applies a remote property write to a live (non-deleted) entity', () => {
    const view = new MutablePropertyView(null, 'room-model');

    const reason = applyRemoteProperty(view, 42, 'Pset_Remote', 'Status', 'LIVE_FROM_PEER', PropertyValueType.Label);

    assert.strictEqual(reason, null);
    assert.strictEqual(view.getPropertyValue(42, 'Pset_Remote', 'Status'), 'LIVE_FROM_PEER');
  });
});

describe('applyRemotePropertyDelete refuses a delete of a locally tombstoned entity', () => {
  it('rejects instead of recording the delete, leaving the property intact after restoreFromTombstone', () => {
    const view = new MutablePropertyView(null, 'room-model');
    view.setProperty(42, 'Pset_Remote', 'Status', 'original', PropertyValueType.Label);
    view.deleteEntity(42);

    const reason = applyRemotePropertyDelete(view, 42, 'Pset_Remote', 'Status');

    assert.strictEqual(reason, 'entity 42 is locally deleted');

    view.restoreFromTombstone(42);

    assert.strictEqual(view.isDeleted(42), false);
    assert.strictEqual(view.getPropertyValue(42, 'Pset_Remote', 'Status'), 'original');
  });

  it('still applies a remote property delete to a live (non-deleted) entity', () => {
    const view = new MutablePropertyView(null, 'room-model');
    view.setProperty(42, 'Pset_Remote', 'Status', 'original', PropertyValueType.Label);

    const reason = applyRemotePropertyDelete(view, 42, 'Pset_Remote', 'Status');

    assert.strictEqual(reason, null);
    assert.strictEqual(view.getPropertyValue(42, 'Pset_Remote', 'Status'), null);
  });
});

describe('applyRemotePsetDelete refuses a delete of a locally tombstoned entity', () => {
  it('rejects instead of recording the delete, leaving the pset intact after restoreFromTombstone', () => {
    const view = new MutablePropertyView(null, 'room-model');
    view.setProperty(42, 'Pset_Remote', 'Status', 'original', PropertyValueType.Label);
    view.deleteEntity(42);

    const reason = applyRemotePsetDelete(view, 42, 'Pset_Remote');

    assert.strictEqual(reason, 'entity 42 is locally deleted');

    view.restoreFromTombstone(42);

    assert.strictEqual(view.isDeleted(42), false);
    assert.strictEqual(view.getPropertyValue(42, 'Pset_Remote', 'Status'), 'original');
  });

  it('still applies a remote pset delete to a live (non-deleted) entity', () => {
    const view = new MutablePropertyView(null, 'room-model');
    view.setProperty(42, 'Pset_Remote', 'Status', 'original', PropertyValueType.Label);

    const reason = applyRemotePsetDelete(view, 42, 'Pset_Remote');

    assert.strictEqual(reason, null);
    assert.strictEqual(view.getPropertyValue(42, 'Pset_Remote', 'Status'), null);
  });
});
