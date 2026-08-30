/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The dialog's two property-set controls describe ONE decision (#3351).
 *
 * "Property sets -> Anonymize" only cleared `HasPropertySets` on type classes,
 * so a pset pulled in by the `IfcRelDefinesByProperties` walk survived with its
 * values while the label said it was dropped. The reachable bad state is
 * exactly: walk ON and psets "anonymized". These rows pin that it cannot be
 * reached from either control.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  coupleTogglesToRelations,
  coupleRelationsToToggles,
  DEFAULT_ANONYMIZE_TOGGLES,
} from './AnonymizationOptionsPanel.js';

const keep = { ...DEFAULT_ANONYMIZE_TOGGLES, propertySets: false };
const anonymize = { ...DEFAULT_ANONYMIZE_TOGGLES, propertySets: true };

test('choosing Anonymize while the source-pset walk is on turns the walk off', () => {
  const { turnRelationOff } = coupleTogglesToRelations(anonymize, true);
  assert.equal(turnRelationOff, true);
});

test('choosing Anonymize while the walk is already off changes nothing', () => {
  // Anti-vacuity: if this returned true as well, the assertion above would pass
  // for a function that ignores its arguments.
  const { turnRelationOff } = coupleTogglesToRelations(anonymize, false);
  assert.equal(turnRelationOff, false);
});

test('choosing Keep never touches the walk', () => {
  assert.equal(coupleTogglesToRelations(keep, true).turnRelationOff, false);
  assert.equal(coupleTogglesToRelations(keep, false).turnRelationOff, false);
});

test('turning the walk on flips Anonymize to Keep', () => {
  assert.equal(coupleRelationsToToggles(anonymize, true).propertySets, false);
});

test('turning the walk on when already Keep is a no-op, and the SAME object', () => {
  // Identity matters: this feeds a React setState, and returning a fresh object
  // every time would re-render on every unrelated relation toggle.
  const same = coupleRelationsToToggles(keep, true);
  assert.equal(same, keep);
});

test('turning the walk OFF never flips the toggle', () => {
  assert.equal(coupleRelationsToToggles(anonymize, false).propertySets, true);
});

test('the bad state is unreachable from either direction', () => {
  // walk on + anonymize is the state that leaked. Drive at it both ways.
  const fromToggle = coupleTogglesToRelations(anonymize, true);
  assert.ok(fromToggle.turnRelationOff, 'the walk must be turned off');
  const fromRelation = coupleRelationsToToggles(anonymize, true);
  assert.equal(fromRelation.propertySets, false, 'anonymize must be released');
});
