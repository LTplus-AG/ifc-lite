/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared WebGL capability gate (#2401).
 *
 * `lib/geo/map-webgl-support.test.ts` already exercises this logic end-to-end
 * through the MapLibre gate. What is only testable HERE is the factory's own
 * contract, which that file cannot see: that a second consumer gets its own
 * latch (a `/mcp` scene must not be able to answer for the minimap, or vice
 * versa), and that the attributes a consumer configures actually reach
 * `getContext` — a probe that dropped them would answer "supported" on exactly
 * the constrained devices this exists for, which is the failure mode the
 * module header warns about.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWebglCapabilityGate,
  type ProbeCanvas,
  type ProbeContext,
} from './webgl-capability.js';

type Reason = 'probe_no_context' | 'construction_failed';

const ATTRS = Object.freeze({ antialias: true, powerPreference: 'high-performance', depth: true });

function makeGate(label = 'test') {
  return createWebglCapabilityGate<Reason>({
    attributes: ATTRS,
    probeFailureReason: 'probe_no_context',
    label,
  });
}

/** A canvas that hands out a context and records what was asked for. */
function grantingCanvas() {
  const asked: Array<{ type: string; attributes: unknown }> = [];
  let released = 0;
  const context: ProbeContext = {
    getExtension: (name) => (name === 'WEBGL_lose_context' ? { loseContext: () => { released += 1; } } : null),
  };
  const canvas: ProbeCanvas = {
    getContext: (type, attributes) => {
      asked.push({ type, attributes });
      return context;
    },
  };
  return { canvas, asked, released: () => released };
}

/** A canvas that refuses, like a device with no WebGL2. */
function refusingCanvas() {
  const asked: Array<{ type: string; attributes: unknown }> = [];
  const canvas: ProbeCanvas = {
    getContext: (type, attributes) => {
      asked.push({ type, attributes });
      return null;
    },
  };
  return { canvas, asked };
}

describe('createWebglCapabilityGate', () => {
  it('asks for webgl2 with the exact attributes the consumer configured', () => {
    const gate = makeGate();
    const { canvas, asked } = grantingCanvas();

    assert.equal(gate.probe(() => canvas).supported, true);

    assert.equal(asked.length, 1);
    assert.equal(asked[0].type, 'webgl2');
    // Not `deepEqual` against a fresh literal only — identity would let a
    // future refactor pass a *copy* with a field quietly dropped and still
    // look green. Compare the values that decide the verdict.
    assert.deepEqual(asked[0].attributes, ATTRS);
  });

  it('releases the probe context so the probe cannot cause the failure it screens for', () => {
    const gate = makeGate();
    const { canvas, released } = grantingCanvas();
    gate.probe(() => canvas);
    assert.equal(released(), 1);
  });

  it('latches a refusal and never re-probes for the rest of the session', () => {
    const gate = makeGate();
    const { canvas, asked } = refusingCanvas();

    assert.deepEqual(gate.probe(() => canvas), { supported: false, reason: 'probe_no_context' });
    assert.deepEqual(gate.probe(() => canvas), { supported: false, reason: 'probe_no_context' });

    assert.equal(asked.length, 1, 'a latched verdict must not burn a second context slot');
  });

  it('keeps the FIRST reason when a later failure is marked', () => {
    const gate = makeGate();
    gate.markUnsupported('construction_failed');
    gate.markUnsupported('probe_no_context');
    assert.deepEqual(gate.getVerdict(), { supported: false, reason: 'construction_failed' });
  });

  it('hands out the report slot exactly once', () => {
    const gate = makeGate();
    assert.equal(gate.takeReportSlot(), true);
    assert.equal(gate.takeReportSlot(), false);
    assert.equal(gate.takeReportSlot(), false);
  });

  it('gives each consumer its own latch and its own report slot', () => {
    // The real coupling risk: the minimap and the /mcp scenes request
    // different attributes, so one answering for the other would be wrong even
    // though both are "WebGL".
    const map = makeGate('map');
    const three = makeGate('three');
    const { canvas: refuses } = refusingCanvas();
    const { canvas: grants } = grantingCanvas();

    assert.equal(map.probe(() => refuses).supported, false);
    assert.equal(map.takeReportSlot(), true);

    assert.equal(three.getVerdict(), null, 'a sibling gate must not inherit a verdict');
    assert.equal(three.probe(() => grants).supported, true);
    assert.equal(three.takeReportSlot(), true, 'a sibling gate must not inherit a spent report slot');
  });

  it('stays optimistic when there is no canvas to probe with', () => {
    // SSR / the Node test runner: nothing renders, and guessing "unsupported"
    // would be a worse default than deferring to the caller's try/catch.
    const gate = makeGate();
    assert.deepEqual(gate.probe(() => null), { supported: true });
  });

  it('treats a throwing getContext as a refusal rather than propagating it', () => {
    const gate = makeGate();
    const canvas: ProbeCanvas = {
      getContext: () => { throw new Error('GPU process is wedged'); },
    };
    assert.deepEqual(gate.probe(() => canvas), { supported: false, reason: 'probe_no_context' });
  });
});
