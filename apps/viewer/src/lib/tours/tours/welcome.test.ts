/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4864 turned right-drag from pan into fly navigation, and the welcome tour's
 * "Look around" step now teaches it. A completion stored before that change
 * must not count as having seen it: `TourDefinition.version` is the lever, and
 * the Learn hub, the first-run invite and the panel help buttons all read it
 * through `isTourCompleted` (#4868 review).
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTourCompleted, markTourCompleted } from '../storage.js';
import { WELCOME_TOUR } from './welcome.js';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
  removeItem(key: string): void { this.store.delete(key); }
}

const g = globalThis as unknown as { window?: unknown };
const hadWindow = 'window' in g;
const previousWindow = g.window;

describe('welcome tour content version (#4868)', () => {
  afterEach(() => {
    if (hadWindow) g.window = previousWindow;
    else delete g.window;
  });

  it('a completion recorded before right-drag became fly does not count', () => {
    g.window = { localStorage: new MemoryStorage() };
    const orbitStep = WELCOME_TOUR.steps.find((s) => s.id === 'orbit');
    assert.match(orbitStep?.body ?? '', /right-click to fly/i, 'precondition: the step teaches fly navigation');

    markTourCompleted(WELCOME_TOUR.id, 1); // what a user who finished the old "Right-drag to pan" tour has stored
    assert.equal(isTourCompleted(WELCOME_TOUR.id, WELCOME_TOUR.version), false, 'they must be offered the updated tour');

    markTourCompleted(WELCOME_TOUR.id, WELCOME_TOUR.version);
    assert.equal(isTourCompleted(WELCOME_TOUR.id, WELCOME_TOUR.version), true);
  });
});
