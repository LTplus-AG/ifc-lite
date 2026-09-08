/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The #1959 leak in `useIfcLoader` is the one the rest of the issue could not
 * take: the processor's raw handle goes to `IfcParser.parseColumnar` via
 * `getApi()`, so freeing it when the geometry block ends would pull memory out
 * from under a live parse. These cases pin the ordering rule that makes the
 * free safe — never before the parse settles, always after — plus the two ways
 * the parse can be absent entirely.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGeometryProcessorDisposer } from './geometryHandleDisposal.js';

describe('createGeometryProcessorDisposer', () => {
  it('frees immediately when no parse was ever scheduled', () => {
    // The engine-init / SharedArrayBuffer window: the processor exists but the
    // parse chain was never started, so there is nothing to wait for.
    let frees = 0;
    const disposer = createGeometryProcessorDisposer(() => { frees += 1; });

    disposer.release();

    assert.equal(frees, 1);
  });

  it('holds the handle while a scheduled parse is still in flight', () => {
    let frees = 0;
    const disposer = createGeometryProcessorDisposer(() => { frees += 1; });

    disposer.parseScheduled();
    disposer.release();

    assert.equal(frees, 0, 'freeing here would pull the handle out from under parseColumnar');
  });

  it('frees when the parse settles after the geometry stream released', () => {
    let frees = 0;
    const disposer = createGeometryProcessorDisposer(() => { frees += 1; });

    disposer.parseScheduled();
    disposer.release();
    disposer.parseSettled();

    assert.equal(frees, 1);
  });

  it('frees when the geometry stream releases after the parse settled', () => {
    // The reverse order: the parser finished first and the stream drained (or
    // threw) later. Whichever consumer is last must trigger the free.
    let frees = 0;
    const disposer = createGeometryProcessorDisposer(() => { frees += 1; });

    disposer.parseScheduled();
    disposer.parseSettled();
    assert.equal(frees, 0, 'the geometry stream still holds it');

    disposer.release();

    assert.equal(frees, 1);
  });

  it('frees exactly once across repeated release and settle calls', () => {
    // `release()` is wired to the outer `finally`, which runs on every exit
    // path including ones that already released — a second free would be a
    // double-free rather than a leak.
    let frees = 0;
    const disposer = createGeometryProcessorDisposer(() => { frees += 1; });

    disposer.parseScheduled();
    disposer.release();
    disposer.parseSettled();
    disposer.release();
    disposer.parseSettled();

    assert.equal(frees, 1);
  });

  it('never frees while the load is still running, even once the parse settled', () => {
    // No `release()` at all: the handle stays live, because the geometry
    // stream has not finished with it.
    let frees = 0;
    const disposer = createGeometryProcessorDisposer(() => { frees += 1; });

    disposer.parseScheduled();
    disposer.parseSettled();

    assert.equal(frees, 0);
  });
});
