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
  watchContextCreationStatus,
  reconstructMapInitFailure,
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

/**
 * maplibre-gl v6's replacement for all of the above.
 *
 * v6 no longer throws: `_setupPainter` fires an `error` event carrying a
 * `GPUInitializationError` and returns with `painter` undefined. The
 * diagnostics moved off the message and onto real properties, and the class is
 * exported, so the shape is stable to construct here.
 */
function gpuInitializationError(statusMessage: string | null) {
  const err = new Error(
    'WebGL2 is required to display this map. We are sorry, but it seems that your '
    + 'browser does not support WebGL2, a technology for rendering 3D graphics on the web.',
  ) as Error & { statusMessage: string | null };
  err.name = 'GPUInitializationError';
  err.statusMessage = statusMessage;
  return err;
}

/** A canvas whose `getContext` always refuses — the unsupported device. */
function refusingCanvas(calls: string[]) {
  return {
    getContext(type: string) {
      calls.push(type);
      return null;
    },
  };
}

/**
 * A device that serves WebGL1 but not WebGL2.
 *
 * This is the case the v6 bump turns from "works" into "cannot work": v6
 * dropped WebGL1 entirely, so a probe that accepted a `webgl` context would
 * report supported and then MapLibre would refuse to start.
 */
function webgl1OnlyCanvas(calls: string[]) {
  return {
    getContext(type: string) {
      calls.push(type);
      if (type !== 'webgl') return null;
      return { getExtension: () => null };
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

  it('recognises the v6 GPUInitializationError by name alone', () => {
    // The shape that actually reaches us on the pinned version. Matching on
    // `.name` and not on `instanceof` keeps maplibre-gl out of this module.
    //
    // The message here is deliberately NOT MapLibre's: with the real wording
    // the message branch would match too and this would pass even with the
    // name check deleted. A reworded message in some future 6.x is exactly the
    // drift the name is here to survive.
    const renamed = new Error('the GPU said no') as Error & { statusMessage: string | null };
    renamed.name = 'GPUInitializationError';
    renamed.statusMessage = null;
    assert.equal(isWebglContextCreationError(renamed), true);
  });

  it('recognises the real v6 error as shipped', () => {
    assert.equal(isWebglContextCreationError(gpuInitializationError(null)), true);
  });

  it('recognises the v6 wording even if the name is lost', () => {
    // A re-thrown or structured-cloned error can arrive with `name` reset to
    // 'Error' while the message survives.
    const stripped = new Error(
      'WebGL2 is required to display this map. We are sorry, but it seems that your '
      + 'browser does not support WebGL2, a technology for rendering 3D graphics on the web.',
    );
    assert.equal(isWebglContextCreationError(stripped), true);
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

  it('reads the driver status off the v6 error property', () => {
    // v6 moved the diagnostics from the JSON message onto the error itself.
    // Losing this would turn every v6 map failure into one unactionable bucket.
    const detail = describeMapInitFailure(
      gpuInitializationError('OES_packed_depth_stencil support is required.'),
    );
    assert.equal(detail.status, 'OES_packed_depth_stencil support is required.');
    assert.equal(detail.eventType, 'webglcontextcreationerror');
  });

  it('returns nothing extractable when v6 had no creation event to quote', () => {
    // `statusMessage` is null unless a `webglcontextcreationerror` supplied one.
    assert.deepEqual(describeMapInitFailure(gpuInitializationError(null)), {});
  });
});

describe('watchContextCreationStatus', () => {
  /** Minimal stand-in for the container: records how the listener was bound. */
  function fakeContainer() {
    const bound: Array<{ type: string; capture: boolean; fn: (ev: Event) => void }> = [];
    return {
      bound,
      addEventListener(type: string, fn: (ev: Event) => void, capture: boolean) {
        bound.push({ type, capture, fn });
      },
      removeEventListener(type: string, fn: (ev: Event) => void, capture: boolean) {
        const i = bound.findIndex(b => b.type === type && b.fn === fn && b.capture === capture);
        if (i >= 0) bound.splice(i, 1);
      },
    };
  }

  it('binds on the CAPTURE phase, because the event does not bubble', () => {
    // The whole mechanism rests on this. `webglcontextcreationerror` is
    // dispatched on the canvas with `bubbles: false`, so a listener on the
    // container is only ever reached on the way down to the target. Bound on
    // the bubble phase this would silently never fire.
    const container = fakeContainer();
    watchContextCreationStatus(container);
    assert.equal(container.bound.length, 1);
    assert.equal(container.bound[0].type, 'webglcontextcreationerror');
    assert.equal(container.bound[0].capture, true);
  });

  it('keeps the driver status the event carried', () => {
    const container = fakeContainer();
    const watch = watchContextCreationStatus(container);
    assert.equal(watch.statusMessage(), null);
    container.bound[0].fn({ statusMessage: 'OES_packed_depth_stencil support is required.' } as unknown as Event);
    assert.equal(watch.statusMessage(), 'OES_packed_depth_stencil support is required.');
  });

  it('ignores an event with no usable status', () => {
    const container = fakeContainer();
    const watch = watchContextCreationStatus(container);
    container.bound[0].fn({ statusMessage: '' } as unknown as Event);
    container.bound[0].fn({} as unknown as Event);
    assert.equal(watch.statusMessage(), null);
  });

  it('stop() unbinds, so a remount cannot stack listeners on the container', () => {
    const container = fakeContainer();
    const watch = watchContextCreationStatus(container);
    watch.stop();
    assert.equal(container.bound.length, 0);
  });
});

describe('reconstructMapInitFailure', () => {
  it('rebuilds an error the rest of the module recognises and can mine', () => {
    // THE regression assertion for the reported gap: a bare `new Error(...)` on
    // the no-painter path made `describeMapInitFailure` return nothing, so
    // `webgl_status` was dropped and every v6 map failure looked identical.
    const err = reconstructMapInitFailure('BindToCurrentSequence failed: .');
    assert.equal(isWebglContextCreationError(err), true);
    const detail = describeMapInitFailure(err);
    assert.equal(detail.status, 'BindToCurrentSequence failed: .');
    assert.equal(detail.eventType, 'webglcontextcreationerror');
  });

  it('is still recognisable when the driver said nothing', () => {
    const err = reconstructMapInitFailure(null);
    assert.equal(isWebglContextCreationError(err), true);
    assert.deepEqual(describeMapInitFailure(err), {});
  });
});

describe('probeMapWebglSupport', () => {
  it('reports unsupported when no context can be created', () => {
    const calls: string[] = [];
    const result = probeMapWebglSupport(() => refusingCanvas(calls));
    assert.equal(result.supported, false);
    assert.equal(result.reason, 'probe_no_context');
    // v6 is WebGL2-only, so the probe asks for exactly one context type.
    assert.deepEqual(calls, ['webgl2']);
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

  it('reports a WebGL1-only device as unsupported and never asks for webgl', () => {
    // THE v6 regression assertion. Before the bump the probe fell back to
    // `getContext('webgl')`, so this device passed and MapLibre v5 ran on it.
    // v6 requires WebGL2, so accepting a WebGL1 context here would report
    // "supported" and hand the user a map that cannot start.
    const calls: string[] = [];
    const result = probeMapWebglSupport(() => webgl1OnlyCanvas(calls));
    assert.equal(result.supported, false);
    assert.equal(result.reason, 'probe_no_context');
    assert.deepEqual(calls, ['webgl2']);
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
    assert.deepEqual(calls, ['webgl2']);

    for (let i = 0; i < 20; i++) {
      const again = probeMapWebglSupport(() => refusingCanvas(calls));
      assert.equal(again.supported, false);
      assert.equal(again.reason, 'probe_no_context');
    }
    // Zero further getContext calls: the verdict is a property of the device.
    assert.deepEqual(calls, ['webgl2']);
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
