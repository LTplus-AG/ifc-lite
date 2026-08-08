/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the `was_hidden` load stamp (#2385). Load timings are wall-clock,
 * so a load spanning a tab switch reports the user's absence as work; this flag
 * is what lets the perf queries drop those rows on evidence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { visibilityWitness, __resetVisibilityWitnessForTest } from './visibilityWitness.js';

interface FakeDoc {
  visibilityState: 'visible' | 'hidden';
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  hide: () => void;
  show: () => void;
  listenerCount: () => number;
}

function installFakeDocument(): FakeDoc {
  const listeners: (() => void)[] = [];
  const doc: FakeDoc = {
    visibilityState: 'visible',
    addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.push(fn); },
    removeEventListener: (type, fn) => {
      if (type !== 'visibilitychange') return;
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hide: () => { doc.visibilityState = 'hidden'; for (const fn of [...listeners]) fn(); },
    show: () => { doc.visibilityState = 'visible'; for (const fn of [...listeners]) fn(); },
    listenerCount: () => listeners.length,
  };
  (globalThis as { document?: unknown }).document = doc;
  __resetVisibilityWitnessForTest();
  return doc;
}

function uninstallFakeDocument(): void {
  Reflect.deleteProperty(globalThis, 'document');
  __resetVisibilityWitnessForTest();
}

test('#2385 a load that stays visible is not flagged', () => {
  const doc = installFakeDocument();
  try {
    const wasHidden = visibilityWitness();
    doc.show(); // a visibilitychange that resolves to visible must not count
    assert.equal(wasHidden(), false);
  } finally { uninstallFakeDocument(); }
});

test('#2385 a load that is hidden partway through is flagged', () => {
  const doc = installFakeDocument();
  try {
    const wasHidden = visibilityWitness();
    assert.equal(wasHidden(), false, 'clean before the tab switch');
    doc.hide();
    doc.show();
    assert.equal(wasHidden(), true, 'the flag must survive the user coming back');
  } finally { uninstallFakeDocument(); }
});

test('#2385 a load STARTED in an already-hidden tab is flagged (no transition fires)', () => {
  const doc = installFakeDocument();
  try {
    doc.visibilityState = 'hidden'; // already backgrounded; no event to observe
    const wasHidden = visibilityWitness();
    assert.equal(wasHidden(), true);
  } finally { uninstallFakeDocument(); }
});

test('#2385 a later load is not retro-tainted by an earlier tab switch', () => {
  const doc = installFakeDocument();
  try {
    const first = visibilityWitness();
    doc.hide();
    doc.show();
    const second = visibilityWitness();
    assert.equal(first(), true, 'the load that spanned the switch is flagged');
    assert.equal(second(), false, 'a load starting after it is clean');
  } finally { uninstallFakeDocument(); }
});

test('#2385 a reset detaches the listener, so reinstalling does not double the witness', () => {
  const doc = installFakeDocument();
  try {
    visibilityWitness();                    // installs
    __resetVisibilityWitnessForTest();      // must DETACH, not just clear the flag
    const wasHidden = visibilityWitness();  // reinstalls against the same document

    assert.equal(doc.listenerCount(), 1, 'a retained stale listener would accumulate');
    doc.hide();
    // A doubled listener counts one hide twice. The witness would still read
    // `true` here, so assert on the count itself — the doubling is what makes a
    // later test pass for the wrong reason.
    assert.equal(wasHidden(), true);
  } finally { uninstallFakeDocument(); }
});

test('#2385 the listener is installed once, not once per load', () => {
  const doc = installFakeDocument();
  try {
    for (let i = 0; i < 25; i++) visibilityWitness();
    assert.equal(doc.listenerCount(), 1, 'a per-load listener would leak on every load');
  } finally { uninstallFakeDocument(); }
});
