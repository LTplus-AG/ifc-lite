/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeMapWebglSupport,
  markMapWebglUnsupported,
  takeMapWebglReportSlot,
  getMapWebglVerdict,
  isWebglContextCreationError,
  describeMapInitFailure,
  resetMapWebglSupportForTests,
} from './map-webgl-support.js';

// The two production failures, verbatim from error tracking (issue #1914).
// Both arrived as UNCAUGHT exceptions from one user in one session.
const MISSING_EXTENSION = JSON.stringify({
  requestedAttributes: {
    antialias: false, preserveDrawingBuffer: false,
    powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false,
    desynchronized: false, alpha: true, depth: true, stencil: true,
    premultipliedAlpha: true,
  },
  statusMessage: 'OES_packed_depth_stencil support is required.',
  type: 'webglcontextcreationerror',
  message: 'Failed to initialize WebGL',
});

const GPU_PROCESS_CONTENTION = JSON.stringify({
  requestedAttributes: {
    antialias: false, preserveDrawingBuffer: false,
    powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false,
    desynchronized: false, alpha: true, depth: true, stencil: true,
    premultipliedAlpha: true,
  },
  statusMessage:
    'Could not create a WebGL context, VENDOR = 0x1002, DEVICE = 0x1638, '
    + 'GL_VENDOR = Google Inc. (AMD), GL_RENDERER = ANGLE (AMD, AMD Radeon(TM) '
    + 'Graphics, D3D11), Sandboxed = yes, ErrorMessage = BindToCurrentSequence failed: .',
  type: 'webglcontextcreationerror',
  message: 'Failed to initialize WebGL',
});

/** MapLibre's other shape: no detail object, so it throws the bare message. */
const BARE_MESSAGE = 'Failed to initialize WebGL';

/** A canvas whose `getContext` always refuses — the unsupported device. */
function refusingCanvas(calls: string[]) {
  return {
    getContext(type: string) {
      calls.push(type);
      return null;
    },
  };
}

/** A canvas that serves webgl2, recording whether the context was released. */
function workingCanvas(calls: string[], released: { count: number }) {
  return {
    getContext(type: string) {
      calls.push(type);
      if (type !== 'webgl2') return null;
      return {
        getExtension(name: string) {
          if (name !== 'WEBGL_lose_context') return null;
          return { loseContext: () => { released.count++; } };
        },
      };
    },
  };
}

beforeEach(() => {
  resetMapWebglSupportForTests();
});

describe('isWebglContextCreationError', () => {
  it('recognises the production missing-extension failure', () => {
    assert.equal(isWebglContextCreationError(new Error(MISSING_EXTENSION)), true);
  });

  it('recognises the production GPU-process-contention failure', () => {
    assert.equal(isWebglContextCreationError(new Error(GPU_PROCESS_CONTENTION)), true);
  });

  it('recognises the bare-message shape MapLibre throws without a detail object', () => {
    assert.equal(isWebglContextCreationError(new Error(BARE_MESSAGE)), true);
  });

  it('does not over-match an unrelated error', () => {
    // Guards the narrowness that keeps a real map bug from being swallowed.
    assert.equal(isWebglContextCreationError(new Error('boom')), false);
    assert.equal(isWebglContextCreationError(new Error('Failed to fetch')), false);
    assert.equal(isWebglContextCreationError(null), false);
    assert.equal(isWebglContextCreationError(undefined), false);
    assert.equal(isWebglContextCreationError({}), false);
  });
});

describe('describeMapInitFailure', () => {
  it('extracts the driver status and event type from the JSON shape', () => {
    const detail = describeMapInitFailure(new Error(MISSING_EXTENSION));
    assert.equal(detail.status, 'OES_packed_depth_stencil support is required.');
    assert.equal(detail.eventType, 'webglcontextcreationerror');
  });

  it('extracts the contention status too', () => {
    const detail = describeMapInitFailure(new Error(GPU_PROCESS_CONTENTION));
    assert.match(String(detail.status), /BindToCurrentSequence failed/);
  });

  it('returns nothing extractable for the bare-message shape', () => {
    assert.deepEqual(describeMapInitFailure(new Error(BARE_MESSAGE)), {});
  });

  it('survives a message that starts like JSON but is not', () => {
    assert.deepEqual(describeMapInitFailure(new Error('{not json')), {});
  });
});

describe('probeMapWebglSupport', () => {
  it('reports unsupported when no context can be created', () => {
    const calls: string[] = [];
    const result = probeMapWebglSupport(() => refusingCanvas(calls));
    assert.equal(result.supported, false);
    assert.equal(result.reason, 'probe_no_context');
    // MapLibre's own order: webgl2 first, then webgl.
    assert.deepEqual(calls, ['webgl2', 'webgl']);
  });

  it('reports supported and RELEASES the probe context', () => {
    // Load-bearing: a browser allows only ~16 live WebGL contexts per page, so
    // a leaked probe context could cause the very failure it screens for.
    const calls: string[] = [];
    const released = { count: 0 };
    const result = probeMapWebglSupport(() => workingCanvas(calls, released));
    assert.equal(result.supported, true);
    assert.deepEqual(calls, ['webgl2']);
    assert.equal(released.count, 1);
  });

  it('treats a throwing getContext as a refusal rather than propagating', () => {
    const result = probeMapWebglSupport(() => ({
      getContext() { throw new Error('gpu process gone'); },
    }));
    assert.equal(result.supported, false);
    assert.equal(result.reason, 'probe_no_context');
  });

  it('stays optimistic when there is no DOM to probe with', () => {
    // Node / SSR: nothing renders, so deferring to the caller's try/catch is a
    // better default than guessing "unsupported".
    assert.equal(probeMapWebglSupport(() => null).supported, true);
  });

  it('latches the failure so a remount never re-probes', () => {
    // THE regression assertion. The Georeferencing section is a Radix
    // Collapsible: collapsing and re-expanding remounts the panel. Before the
    // fix every remount rebuilt the map and threw again, uncaught.
    const calls: string[] = [];
    const first = probeMapWebglSupport(() => refusingCanvas(calls));
    assert.equal(first.supported, false);
    assert.deepEqual(calls, ['webgl2', 'webgl']);

    for (let i = 0; i < 20; i++) {
      const again = probeMapWebglSupport(() => refusingCanvas(calls));
      assert.equal(again.supported, false);
      assert.equal(again.reason, 'probe_no_context');
    }
    // Zero further getContext calls: the verdict is a property of the device.
    assert.deepEqual(calls, ['webgl2', 'webgl']);
  });

  it('latches success too, so the probe costs one context per session', () => {
    const calls: string[] = [];
    const released = { count: 0 };
    probeMapWebglSupport(() => workingCanvas(calls, released));
    probeMapWebglSupport(() => workingCanvas(calls, released));
    assert.deepEqual(calls, ['webgl2']);
    assert.equal(released.count, 1);
  });

  it('honours a verdict latched by a real construction failure', () => {
    // The probe can pass and `new maplibregl.Map(...)` still throw under GPU
    // contention. Once that has happened, the probe must not undo it.
    const calls: string[] = [];
    const released = { count: 0 };
    markMapWebglUnsupported('map_construction_failed');
    const result = probeMapWebglSupport(() => workingCanvas(calls, released));
    assert.equal(result.supported, false);
    assert.equal(result.reason, 'map_construction_failed');
    assert.deepEqual(calls, []);
  });
});

describe('markMapWebglUnsupported', () => {
  it('keeps the first reason, so the originating failure is what gets reported', () => {
    markMapWebglUnsupported('map_construction_failed');
    markMapWebglUnsupported('context_lost');
    assert.equal(getMapWebglVerdict()?.reason, 'map_construction_failed');
  });

  it('overrides an earlier positive verdict', () => {
    probeMapWebglSupport(() => workingCanvas([], { count: 0 }));
    assert.equal(getMapWebglVerdict()?.supported, true);
    markMapWebglUnsupported('context_lost');
    assert.equal(getMapWebglVerdict()?.supported, false);
    assert.equal(getMapWebglVerdict()?.reason, 'context_lost');
  });
});

describe('takeMapWebglReportSlot', () => {
  it('grants the slot exactly once per session', () => {
    // Production saw 2 events from 1 user in 1 session; unrationed, a user
    // toggling the panel would flood the exception quota.
    assert.equal(takeMapWebglReportSlot(), true);
    for (let i = 0; i < 10; i++) {
      assert.equal(takeMapWebglReportSlot(), false);
    }
  });
});
