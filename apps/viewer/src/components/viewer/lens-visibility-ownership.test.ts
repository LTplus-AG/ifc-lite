/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  planLensHiddenSync,
  ruleIsolationOwnsChannel,
} from './lens-visibility-ownership.js';

/**
 * Minimal store double: applies a plan to a hidden set exactly the way the
 * panel applies it via showEntities/hideEntities, so multi-step scenarios
 * (lens switch, remount, teardown) can be simulated end to end.
 */
function applyPlan(
  hidden: Set<number>,
  plan: ReturnType<typeof planLensHiddenSync>,
): Set<number> {
  const next = new Set(hidden);
  for (const id of plan.show) next.delete(id);
  for (const id of plan.hide) next.add(id);
  return next;
}

describe('planLensHiddenSync - ownership diff (PR #1777 review finding a)', () => {
  it('activating a lens hides its ids and owns exactly the newly hidden ones', () => {
    const hidden = new Set<number>();
    const plan = planLensHiddenSync({
      applied: [],
      hiddenEntities: hidden,
      lensHiddenIds: new Set([1, 2, 3]),
    });
    assert.deepEqual(plan.show, []);
    assert.deepEqual(plan.hide.sort(), [1, 2, 3]);
    assert.deepEqual(plan.nextApplied.sort(), [1, 2, 3]);
    assert.deepEqual([...applyPlan(hidden, plan)].sort(), [1, 2, 3]);
  });

  it('never claims an id the user manually hid BEFORE the lens applied', () => {
    // User hid 7 manually, then activated a lens that also hides 7 (and 8).
    const hidden = new Set([7]);
    const plan = planLensHiddenSync({
      applied: [],
      hiddenEntities: hidden,
      lensHiddenIds: new Set([7, 8]),
    });
    assert.deepEqual(plan.hide, [8], 'only the not-yet-hidden id is hidden');
    assert.deepEqual(plan.nextApplied, [8], 'the manual hide is not owned');

    // Teardown (deactivate): only 8 is restored; the manual hide of 7 survives.
    const afterApply = applyPlan(hidden, plan);
    const teardown = planLensHiddenSync({
      applied: plan.nextApplied,
      hiddenEntities: afterApply,
      lensHiddenIds: new Set(),
    });
    assert.deepEqual(teardown.show, [8]);
    assert.deepEqual(teardown.hide, []);
    assert.deepEqual(teardown.nextApplied, []);
    assert.deepEqual([...applyPlan(afterApply, teardown)], [7],
      'user manual hide must survive lens teardown');
  });

  it('manual hide made WHILE a lens is active survives switching to another lens', () => {
    // Lens A hides {1,2}. User then manually hides 5. Switch to lens B hiding {2,3}.
    let hidden = new Set<number>();
    const planA = planLensHiddenSync({
      applied: [], hiddenEntities: hidden, lensHiddenIds: new Set([1, 2]),
    });
    hidden = applyPlan(hidden, planA);
    hidden.add(5); // manual hide while A is active

    const planB = planLensHiddenSync({
      applied: planA.nextApplied,
      hiddenEntities: hidden,
      lensHiddenIds: new Set([2, 3]),
    });
    assert.deepEqual(planB.show, [1], 'A-only id is restored');
    assert.deepEqual(planB.hide, [3], 'B-only id is newly hidden');
    assert.deepEqual(planB.nextApplied.sort(), [2, 3], 'ownership of 2 transfers to B');
    hidden = applyPlan(hidden, planB);
    assert.deepEqual([...hidden].sort(), [2, 3, 5], 'manual hide of 5 untouched');

    // Deactivate B: only B-owned ids restored; 5 stays hidden.
    const teardown = planLensHiddenSync({
      applied: planB.nextApplied, hiddenEntities: hidden, lensHiddenIds: new Set(),
    });
    assert.deepEqual([...applyPlan(hidden, teardown)], [5]);
  });

  it('id hidden by BOTH consecutive lenses transfers ownership without churn', () => {
    // No transient un-hide: the shared id appears in neither show nor hide.
    const hidden = new Set([10, 11]);
    const plan = planLensHiddenSync({
      applied: [10, 11],
      hiddenEntities: hidden,
      lensHiddenIds: new Set([11, 12]),
    });
    assert.deepEqual(plan.show, [10]);
    assert.deepEqual(plan.hide, [12]);
    assert.ok(!plan.show.includes(11) && !plan.hide.includes(11), 'no churn on the shared id');
    assert.deepEqual(plan.nextApplied.sort(), [11, 12]);
  });

  it('rapid A -> B -> A toggling round-trips to the initial state', () => {
    const manual = 99;
    let hidden = new Set([manual]);
    let applied: number[] = [];
    const lensA = new Set([1, 2, manual]); // A also hides the manually hidden id
    const lensB = new Set([2, 3]);

    for (const lens of [lensA, lensB, lensA]) {
      const plan = planLensHiddenSync({ applied, hiddenEntities: hidden, lensHiddenIds: lens });
      hidden = applyPlan(hidden, plan);
      applied = plan.nextApplied;
    }
    assert.deepEqual([...hidden].sort(), [1, 2, 99], 'ends in lens A state');
    assert.deepEqual(applied.sort(), [1, 2], 'manual id never claimed across toggles');

    const teardown = planLensHiddenSync({ applied, hiddenEntities: hidden, lensHiddenIds: new Set() });
    hidden = applyPlan(hidden, teardown);
    assert.deepEqual([...hidden], [manual], 'back to exactly the manual hide');
  });

  it('re-running the sync with unchanged inputs is a no-op (panel remount)', () => {
    // Ownership persists in the store, so a remount re-runs the sync with the
    // same inputs - it must not release or re-take anything.
    const hidden = new Set([1, 2, 40]); // 40 = manual
    const plan = planLensHiddenSync({
      applied: [1, 2],
      hiddenEntities: hidden,
      lensHiddenIds: new Set([1, 2]),
    });
    assert.deepEqual(plan.show, []);
    assert.deepEqual(plan.hide, []);
    assert.deepEqual(plan.nextApplied.sort(), [1, 2]);
  });

  it('teardown with nothing applied and nothing active is a no-op (Clear when idle)', () => {
    const plan = planLensHiddenSync({
      applied: [],
      hiddenEntities: new Set([4]),
      lensHiddenIds: new Set(),
    });
    assert.deepEqual(plan, { show: [], hide: [], nextApplied: [] });
  });

  it('owned id the user manually un-hid mid-lens is not force-restored on teardown', () => {
    // Lens owned 6; user un-hid it via the tree while the lens was active.
    const plan = planLensHiddenSync({
      applied: [6],
      hiddenEntities: new Set(), // user already removed it
      lensHiddenIds: new Set(),
    });
    assert.deepEqual(plan.show, [], 'no redundant show for an already-visible id');
  });
});

describe('ruleIsolationOwnsChannel (PR #1777 review finding b)', () => {
  it('owns the channel when isolation holds exactly the applied ids', () => {
    assert.equal(ruleIsolationOwnsChannel(new Set([1, 2, 3]), [3, 2, 1]), true);
  });

  it('does not own when isolation is off', () => {
    assert.equal(ruleIsolationOwnsChannel(null, [1, 2]), false);
  });

  it('does not own when another owner replaced the isolation set', () => {
    // e.g. user right-click isolate or basket isolation after the rule click.
    assert.equal(ruleIsolationOwnsChannel(new Set([9]), [1, 2]), false);
    assert.equal(ruleIsolationOwnsChannel(new Set([1, 2, 9]), [1, 2]), false);
    assert.equal(ruleIsolationOwnsChannel(new Set([1]), [1, 2]), false);
  });

  it('handles duplicate applied ids', () => {
    assert.equal(ruleIsolationOwnsChannel(new Set([1, 2]), [1, 1, 2]), true);
  });

  it('an empty claim never owns a live isolation set', () => {
    assert.equal(ruleIsolationOwnsChannel(new Set([1]), []), false);
    // Degenerate: empty isolation set + empty claim - clearing is a no-op either way.
    assert.equal(ruleIsolationOwnsChannel(new Set(), []), true);
  });
});
