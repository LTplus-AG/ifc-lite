/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Static integrity checks for the tour registry - the cheap, browser-free
 * complement to the runtime rot telemetry (tour_step_broken). Runtime anchor
 * existence can only be checked in a live DOM; here we pin everything that
 * can rot at build time: id uniqueness, step shape per kind, and the plain
 * ASCII copy rule.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOUR_REGISTRY, getTour, getToursForPanel } from './registry.js';

test('tour ids are unique and resolvable', () => {
  const ids = TOUR_REGISTRY.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate tour id');
  for (const t of TOUR_REGISTRY) {
    assert.equal(getTour(t.id), t);
    assert.ok(t.version >= 1, `${t.id}: version must be >= 1`);
    assert.ok(t.minutes > 0, `${t.id}: minutes must be positive`);
    assert.ok(t.title.length > 0 && t.description.length > 0, `${t.id}: empty title/description`);
  }
});

test('steps are unique, well-formed per kind, and skippable by construction', () => {
  for (const tour of TOUR_REGISTRY) {
    const stepIds = tour.steps.map((s) => s.id);
    assert.equal(new Set(stepIds).size, stepIds.length, `${tour.id}: duplicate step id`);
    assert.ok(tour.steps.length >= 2, `${tour.id}: a tour needs at least 2 steps`);
    for (const step of tour.steps) {
      const at = `${tour.id}/${step.id}`;
      assert.ok(step.title.length > 0 && step.body.length > 0, `${at}: empty copy`);
      if (step.kind === 'canvas') {
        assert.equal(step.anchor, undefined, `${at}: canvas steps have no anchor`);
      } else {
        assert.ok(step.anchor, `${at}: anchored steps need an anchor`);
      }
      if (step.kind === 'action') {
        assert.ok(step.gate?.predicate || step.gate?.event, `${at}: action steps need a gate`);
      }
      if (step.gate?.predicate) {
        assert.equal(typeof step.gate.predicate, 'function', `${at}: predicate must be a function`);
      }
    }
  }
});

test('user-facing copy is plain ASCII (no em dashes, no fancy unicode)', () => {
  for (const tour of TOUR_REGISTRY) {
    const texts = [tour.title, tour.description, ...tour.steps.flatMap((s) => [s.title, s.body, s.action?.label ?? ''])];
    for (const text of texts) {
      for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        assert.ok(
          code >= 0x20 && code <= 0x7e,
          `${tour.id}: non-ASCII character ${JSON.stringify(ch)} in ${JSON.stringify(text)}`,
        );
      }
    }
  }
});

test('panel lookup only returns tours that declare that panel', () => {
  for (const tour of TOUR_REGISTRY) {
    if (tour.panel) {
      assert.ok(getToursForPanel(tour.panel).includes(tour));
    }
  }
  assert.deepEqual(
    getToursForPanel('gantt').filter((t) => t.panel !== 'gantt'),
    [],
  );
});
