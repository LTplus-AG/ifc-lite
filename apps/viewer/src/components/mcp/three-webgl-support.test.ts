/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The three.js side of the WebGL capability gate (#2401).
 *
 * The production failure is verbatim from PostHog issue
 * `019fc458-6640-7a23-8f8b-c1897bfd9b20` (Chrome 116 / Linux, `/mcp`):
 * `THREE.WebGLRenderer: Error creating WebGL context.`, thrown out of
 * `HeroScene`'s mount effect and taking the whole route down.
 *
 * The `create` callback here is a real function that really throws — not a
 * stub that reports a throw — so the broken state is expressible: a
 * `startThreeScene` that forgot its `try/catch` propagates out of these tests
 * and fails them.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startThreeScene,
  probeThreeWebglSupport,
  isThreeWebglContextError,
  describeThreeWebglFailure,
  threeProbeFailureError,
  getThreeWebglVerdict,
  takeThreeWebglReportSlot,
  resetThreeWebglSupportForTests,
  type ThreeWebglFailureReason,
} from './three-webgl-support.js';
import { threeWebglReportProperties } from './useThreeScene.js';
import { scrubEvent } from '@/lib/analytics-scrub';

/** posthog-js's `before_send` shape, as `analytics.test.ts` models it. */
type CaptureEvent = { event?: string; properties?: Record<string, unknown> };

/** three@0.185.1's two authored messages, copied from its source. */
const NO_CONTEXT = 'THREE.WebGLRenderer: Error creating WebGL context.';
const ATTRIBUTES_REFUSED = 'THREE.WebGLRenderer: Error creating WebGL context with your selected attributes.';

/** Stands in for the container React would hand us. Never touched on any path
 *  under test — three builds its own detached canvas. */
const CONTAINER = {} as HTMLElement;

interface FakeHandle { dispose(): void }
const HANDLE: FakeHandle = { dispose: () => undefined };

beforeEach(() => {
  resetThreeWebglSupportForTests();
});

describe('isThreeWebglContextError', () => {
  it('matches both of three.js’s context-refusal messages', () => {
    assert.equal(isThreeWebglContextError(new Error(NO_CONTEXT)), true);
    assert.equal(isThreeWebglContextError(new Error(ATTRIBUTES_REFUSED)), true);
  });

  it('does NOT match an unrelated failure that merely mentions WebGL', () => {
    // Narrowness guard. Swallowing one of our own bugs as "your device cannot
    // do 3D" would lie to the user AND lose the bug report.
    assert.equal(isThreeWebglContextError(new Error('THREE.WebGLRenderer: Context Lost.')), false);
    assert.equal(isThreeWebglContextError(new Error('WebGL warning: drawArrays: no program bound')), false);
    assert.equal(isThreeWebglContextError(new Error('Cannot read properties of undefined (reading ‘geometry’)')), false);
    assert.equal(isThreeWebglContextError(undefined), false);
  });
});

describe('describeThreeWebglFailure', () => {
  it('separates "no webgl2 at all" from "refused our attributes"', () => {
    assert.deepEqual(describeThreeWebglFailure(new Error(NO_CONTEXT)), { webgl_context: 'no_context' });
    assert.deepEqual(describeThreeWebglFailure(new Error(ATTRIBUTES_REFUSED)), { webgl_context: 'attributes_refused' });
  });

  it('claims nothing about an error it does not recognise', () => {
    assert.deepEqual(describeThreeWebglFailure(new Error('boom')), {});
  });

  it('recognises the synthesised pre-flight message as the no-context case', () => {
    assert.deepEqual(describeThreeWebglFailure(threeProbeFailureError()), { webgl_context: 'no_context' });
  });
});

describe('startThreeScene', () => {
  it('builds the scene when the device can serve a context', () => {
    const started = startThreeScene<FakeHandle>(CONTAINER, () => HANDLE);
    assert.equal(started.ok, true);
    assert.equal(started.ok && started.handle, HANDLE);
  });

  it('converts three’s context refusal into a degradation instead of a throw', () => {
    // The regression itself: pre-fix, this call propagates and React unwinds
    // the whole /mcp route into ChunkErrorBoundary.
    const started = startThreeScene<FakeHandle>(CONTAINER, () => {
      throw new Error(NO_CONTEXT);
    });
    assert.equal(started.ok, false);
    assert.equal(started.ok === false && started.reason, 'renderer_construction_failed');
    assert.equal(
      started.ok === false && started.error instanceof Error && started.error.message,
      NO_CONTEXT,
      'the original error must be reported, not a paraphrase',
    );
  });

  it('RETHROWS a scene bug that is not a context refusal', () => {
    // A guard that swallowed everything would turn our own crashes into a
    // silent "unavailable on this device" and lose them from error tracking.
    assert.throws(
      () => startThreeScene<FakeHandle>(CONTAINER, () => {
        throw new TypeError('mesh.material is undefined');
      }),
      /mesh\.material is undefined/,
    );
    assert.notEqual(
      getThreeWebglVerdict()?.supported,
      false,
      'an unrelated bug must not latch the device as GPU-less',
    );
  });

  it('latches the device so a remount never touches the GPU again', () => {
    let creates = 0;
    const create = () => {
      creates += 1;
      throw new Error(NO_CONTEXT);
    };

    const first = startThreeScene<FakeHandle>(CONTAINER, create);
    const second = startThreeScene<FakeHandle>(CONTAINER, create);

    assert.equal(creates, 1, 'the second mount must not re-attempt construction');
    assert.equal(first.ok === false && first.reason, 'renderer_construction_failed');
    assert.equal(second.ok === false && second.reason, 'renderer_construction_failed');
    assert.equal(
      second.ok === false && second.error,
      undefined,
      'a remount is not new information and must not carry an error to report',
    );
  });

  it('never calls create once the probe has latched a refusal', () => {
    probeThreeWebglSupport(() => ({ getContext: () => null }));

    let creates = 0;
    const started = startThreeScene<FakeHandle>(CONTAINER, () => {
      creates += 1;
      return HANDLE;
    });

    assert.equal(creates, 0);
    assert.equal(started.ok === false && started.reason, 'probe_no_context');
  });
});

/**
 * Build the report inputs from a REAL `startThreeScene` failure.
 *
 * A hand-written `(reason, error)` pair can describe a state the code cannot
 * produce — `probe_no_context` never carries the "selected attributes" error,
 * because that path synthesises its own message and never sees three's. Then
 * the fixture asserts on something unreachable and stops being evidence.
 * Deriving the pair from the code under test makes the pairing correct by
 * construction, so the two enums cannot drift apart here unnoticed.
 */
function reportInputsFor(thrown: Error): { reason: ThreeWebglFailureReason; error: unknown } {
  const started = startThreeScene<FakeHandle>(CONTAINER, () => { throw thrown; });
  assert.equal(started.ok, false, 'fixture precondition: this must be a degradation');
  if (started.ok) throw new Error('unreachable');
  return { reason: started.reason, error: started.error };
}

describe('the degradation report', () => {
  it('is rationed to one per session', () => {
    assert.equal(takeThreeWebglReportSlot(), true);
    assert.equal(takeThreeWebglReportSlot(), false);
  });

  it('survives the analytics scrub with every property intact', () => {
    // Two things at once, both real rather than read off the source:
    //  • the scrub DELETES any key containing name/label/model/path/... , so a
    //    property named `three_label` would vanish silently and the event
    //    would no longer say which surface degraded;
    //  • the scrub DROPS unactionable third-party WebGL noise wholesale, and
    //    this handled report must not be swallowed with it.
    const { reason, error } = reportInputsFor(new Error(ATTRIBUTES_REFUSED));
    const props = threeWebglReportProperties('hero', reason, error);
    const event: CaptureEvent = {
      event: '$exception',
      properties: {
        $exception_list: [{
          type: 'Error',
          value: ATTRIBUTES_REFUSED,
          mechanism: { handled: true, type: 'generic' },
        }],
        ...props,
      },
    };
    const scrubbed = scrubEvent(event);

    assert.notEqual(scrubbed, null, 'the degradation report must not be dropped as noise');
    assert.equal(scrubbed?.properties?.context, 'mcp_three_webgl');
    assert.equal(scrubbed?.properties?.three_surface, 'hero');
    assert.equal(scrubbed?.properties?.three_unavailable_reason, 'renderer_construction_failed');
    assert.equal(scrubbed?.properties?.webgl_context, 'attributes_refused');
  });

  it('files the failure under its own context, not the page-crash bucket', () => {
    // Classification is the honesty requirement: this used to arrive via
    // ChunkErrorBoundary as `lazy_subtree_boundary` — the bucket for "a real
    // bug killed a page". It is a scoped, handled degradation now.
    const { reason, error } = reportInputsFor(new Error(NO_CONTEXT));
    const props = threeWebglReportProperties('playground', reason, error);
    assert.equal(props.context, 'mcp_three_webgl');
    assert.notEqual(props.context, 'lazy_subtree_boundary');
    assert.equal(props.three_surface, 'playground');
  });
});
