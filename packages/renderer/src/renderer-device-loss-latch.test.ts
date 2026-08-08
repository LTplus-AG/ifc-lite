/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { Renderer } from './index.js';

/**
 * Safari's SYNCHRONOUS device-loss signal (issue #2229).
 *
 * Chromium surfaces device loss by resolving `device.lost`, which the renderer
 * already listens to. Safari 26.5 instead throws `InvalidStateError` straight
 * out of the next GPU call — in the field, `GPUDevice.createTexture` inside
 * `RenderPipeline.resize()`, reached from the canvas-resize branch of
 * `render()`. That branch sits outside the frame's inner try/catch, so the
 * throw escaped `render()` entirely: the host's rAF loop never reached its
 * tail `requestAnimationFrame`, the viewer froze permanently, and because
 * `device.lost` never resolved, `deviceLost` never latched and no
 * `onDeviceLost` listener ever ran.
 *
 * These tests pin the four properties of the fix, using a renderer whose
 * `pipeline.resize()` throws exactly as Safari's does:
 *   (i)   the throw does not propagate out of render()
 *   (ii)  `deviceLost` latches
 *   (iii) onDeviceLost listeners fire (once)
 *   (iv)  later render() calls are quiet skips, not repeat throws
 *
 * ...and the boundary of that latch: a throw that is NOT a device signal must
 * cost one frame, not the session (see the second describe block).
 */

/**
 * Verbatim Safari 26.5 wording from the PostHog frames in #2229.
 *
 * The TYPE matters as much as the wording: Safari throws a `DOMException`, and
 * the renderer discriminates on exactly that (`isDeviceLossThrow`). A harness
 * throwing a plain `Error` here would exercise the non-latching branch while
 * claiming to reproduce Safari, and every assertion below would invert.
 */
const SAFARI_LOST = 'The object is in an invalid state.';
const safariDeviceLost = (): DOMException =>
    new DOMException(SAFARI_LOST, 'InvalidStateError');

/**
 * Chromium's host-memory-pressure failure on a HEALTHY device, verbatim from
 * error tracking (the same string `gpu-upload-guard` documents). A plain
 * `RangeError`, not a DOMException — the whole reason the latch discriminates.
 */
const HOST_OOM =
    "Failed to execute 'createBuffer' on 'GPUDevice': createBuffer failed, " +
    'size (193836) is too large for the implementation when mappedAtCreation == true';

/**
 * Node has no WebGPU globals, and `WebGPUDevice.configureContext()` reads
 * `GPUTextureUsage.RENDER_ATTACHMENT`. Without this the configure throws, the
 * context never becomes valid, `ensureContext()` skips the frame — and every
 * assertion about the ENCODE region below would pass vacuously against a frame
 * that never got near it.
 *
 * Harmless to the pre-existing `frame`-site tests: their throw happens at
 * `pipeline.resize()`, which runs before `ensureContext()` either way.
 */
(globalThis as Record<string, unknown>).GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10 };

interface Harness {
    renderer: Renderer;
    /** how many times the throwing GPU call was reached */
    resizeCalls(): number;
    /** stop throwing, so a later frame could succeed if the latch let it */
    stopThrowing(): void;
    /** resume throwing, to start a fresh failure episode */
    startThrowing(): void;
}

/**
 * WHERE in the frame the stub GPU call throws.
 *
 *  - `frame`: `pipeline.resize()`, in the OUTER try/catch region — the reported
 *    Safari 26.5 field crash (#2229).
 *  - `encode`: `currentTexture.createView()`, the first GPU call inside the
 *    frame body's own try/catch — the region that had no device discrimination
 *    at all until #2417, so a device dying there degraded quietly forever.
 */
type ThrowSite = 'frame' | 'encode';

/**
 * A renderer wired to a stub device whose canvas reports a CSS size that
 * differs from its backing store, so every frame takes the
 * `dimensionsChanged` branch and calls `pipeline.resize()`.
 *
 * The reported size ALTERNATES between two 64-aligned widths so that branch is
 * taken on EVERY frame, not just the first. With a fixed size the backing store
 * settles after frame 1 and `pipeline.resize` is never reached again — which
 * would make "later frames issued no GPU work" vacuously true for a latched and
 * an unlatched renderer alike, i.e. a test that cannot fail.
 *
 * (The `encode` site does not depend on that alternation — `getCurrentTexture()`
 * is reached on every frame regardless — but the harness keeps one shape, and
 * `resizeCalls()` then counts `createView` calls instead.)
 */
function makeHarness(
    makeError: () => unknown = safariDeviceLost,
    site: ThrowSite = 'frame',
): Harness {
    let gpuCalls = 0;
    let throwing = true;
    let wide = false;

    const canvas = {
        width: 0,
        height: 0,
        getBoundingClientRect: () => {
            wide = !wide;
            return { width: wide ? 256 : 320, height: 256 };
        },
    } as unknown as HTMLCanvasElement;

    const renderer = new Renderer(canvas);

    /** The stub GPU call under test: counted, and throwing while armed. */
    const gpuCall = () => {
        gpuCalls++;
        // Exactly what Safari does on a dead device: a synchronous throw.
        if (throwing) throw makeError();
    };

    // Minimal live-device stub: enough for render() to get past its entry
    // guards and reach the throwing call.
    const wdev = renderer['device'] as unknown as Record<string, unknown>;
    wdev['device'] = {
        limits: { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024 },
        // The frame pushes a validation scope on its first five calls; without
        // these the frame would throw a TypeError BEFORE the encode region and
        // an "encode" test would silently be exercising the outer catch.
        pushErrorScope() { /* no-op */ },
        popErrorScope: () => Promise.resolve(null),
        queue: { writeBuffer() { /* no-op */ }, submit() { /* no-op */ } },
        createCommandEncoder: () => ({ finish: () => ({}) }),
    };
    wdev['context'] = {
        configure() { /* no-op */ },
        getCurrentTexture: () =>
            (site === 'encode' ? { createView: gpuCall } : null),
    };
    wdev['canvas'] = canvas;
    wdev['contextConfigured'] = true;

    (renderer as unknown as Record<string, unknown>)['pipeline'] = new Proxy(
        {} as Record<string | symbol, unknown>,
        {
            get(_t, prop) {
                if (prop === 'resize') {
                    return site === 'frame' ? gpuCall : () => { /* no-op */ };
                }
                if (prop === 'needsResize') return () => false;
                if (prop === 'getSampleCount') return () => 1;
                return () => ({});
            },
        },
    );

    return {
        renderer,
        resizeCalls: () => gpuCalls,
        stopThrowing() { throwing = false; },
        startThrowing() { throwing = true; },
    };
}

/** Silence (and collect) the once-per-loss console output. */
function withQuietConsole<T>(run: () => T): T {
    const error = mock.method(console, 'error', () => undefined);
    const warn = mock.method(console, 'warn', () => undefined);
    try {
        return run();
    } finally {
        error.mock.restore();
        warn.mock.restore();
    }
}

describe('a listener registered AFTER the loss still learns of it', () => {
    it('replays the latched loss to a late subscriber', () => {
        // `Renderer.init()` subscribes to the device's own loss signal BEFORE
        // awaiting `device.init()`, so a loss DURING initialisation latches
        // while `deviceLostListeners` is still empty. The viewer's subscriber
        // cannot register any earlier — it needs init() to have resolved — so
        // without a replay that loss reaches nobody, and the user sees a
        // viewer that silently stopped with no toast and no capture.
        const h = makeHarness();
        withQuietConsole(() => { h.renderer.render({}); });
        assert.equal(h.renderer.isDeviceLost(), true, 'precondition: the loss latched');

        let seen: { message: string; reason: string } | null = null;
        withQuietConsole(() => {
            h.renderer.onDeviceLost((info) => { seen = info; });
        });

        assert.notEqual(seen, null, 'a listener added after the loss must still be told');
        assert.equal(typeof seen!.reason, 'string');
    });

    it('does not replay to a listener when no loss has happened', () => {
        // The control: without this, a replay that fired unconditionally would
        // satisfy the assertion above for the wrong reason.
        const h = makeHarness();
        let called = 0;
        h.renderer.onDeviceLost(() => { called++; });
        assert.equal(called, 0, 'no loss yet, so nothing to replay');
    });
});

describe('render() latches a synchronous device loss (#2229)', () => {
    it('does not propagate the throw out of render()', () => {
        const h = makeHarness();
        withQuietConsole(() => {
            assert.doesNotThrow(
                () => h.renderer.render(),
                'a GPU call throwing mid-frame must not escape render() — it kills the caller\'s rAF loop',
            );
        });
        assert.strictEqual(h.resizeCalls(), 1, 'the throwing GPU call must actually have been reached');
    });

    it('latches deviceLost, so isDeviceLost() reports the Safari-style loss', () => {
        const h = makeHarness();
        assert.strictEqual(h.renderer.isDeviceLost(), false, 'precondition: device starts alive');
        withQuietConsole(() => h.renderer.render());
        assert.strictEqual(
            h.renderer.isDeviceLost(),
            true,
            'a synchronous loss must latch the same state the async device.lost promise would',
        );
    });

    it('fires onDeviceLost listeners exactly once, with a render-exception reason', () => {
        const h = makeHarness();
        const seen: { message: string; reason: string }[] = [];
        h.renderer.onDeviceLost((info) => { seen.push(info); });

        withQuietConsole(() => {
            h.renderer.render();
            h.renderer.render();
            h.renderer.render();
        });

        assert.strictEqual(seen.length, 1, 'the loss is reported once per device, not once per frame');
        assert.strictEqual(seen[0].reason, 'render-exception');
        assert.match(seen[0].message, /invalid state/i, 'the original GPU message must reach the listener');
    });

    it('leaves later frames as quiet skips: no repeat GPU calls, no repeat logs', () => {
        const h = makeHarness();
        const error = mock.method(console, 'error', () => undefined);
        const warn = mock.method(console, 'warn', () => undefined);
        try {
            h.renderer.render();
            const resizesAfterLoss = h.resizeCalls();
            const errorsAfterLoss = error.mock.calls.length;
            const warnsAfterLoss = warn.mock.calls.length;
            assert.strictEqual(resizesAfterLoss, 1);
            assert.ok(errorsAfterLoss >= 1, 'the first loss must be logged, not swallowed');

            // Even with the GPU healthy again, a latched renderer stays down
            // until the host re-initialises it — the documented contract.
            h.stopThrowing();
            const skipsBefore = h.renderer.getDiagnostics().skips;
            for (let i = 0; i < 5; i++) h.renderer.render();

            assert.strictEqual(h.resizeCalls(), resizesAfterLoss, 'later frames must issue no GPU work at all');
            assert.strictEqual(error.mock.calls.length, errorsAfterLoss, 'later frames must not re-log');
            assert.strictEqual(warn.mock.calls.length, warnsAfterLoss, 'later frames must not re-warn');
            assert.strictEqual(
                h.renderer.getDiagnostics().skips,
                skipsBefore + 5,
                'every later frame is counted as a skip',
            );
        } finally {
            error.mock.restore();
            warn.mock.restore();
        }
    });

    it('records the failure in diagnostics instead of hiding it', () => {
        const h = makeHarness();
        withQuietConsole(() => h.renderer.render());
        const diag = h.renderer.getDiagnostics();
        assert.strictEqual(diag.errors, 1, 'a swallowed-looking frame must still be counted as an error');
        assert.match(diag.lastError, /invalid state/i);
    });
});

describe('a NON-device throw costs one frame, not the session (#2229 review)', () => {
    // The latch above must not be over-broad. `render()`'s outer catch covers
    // more than the resize branch: `scene.restoreAllEvicted()` runs inside it
    // for capture frames, and its `createBuffer({ mappedAtCreation: true })`
    // throws a plain RangeError under host memory pressure on a device that is
    // perfectly alive. That path is reached on purpose by BCF clash snapshots
    // and IDS report captures (`restoreEvictedForCapture: true`), both of whose
    // callers already contain the failure. Latching there would turn a degraded
    // export into a permanently dead viewport, with a false "graphics device
    // was lost" toast and false `device_lost` telemetry on top — and it would
    // contradict the rAF loop's own neighbours, which degrade per occurrence.

    it('does not latch deviceLost when the frame throws a RangeError', () => {
        const h = makeHarness(() => new RangeError(HOST_OOM));
        withQuietConsole(() => { h.renderer.render(); });
        assert.strictEqual(
            h.renderer.isDeviceLost(),
            false,
            'host memory pressure is not a device loss — the device is still alive',
        );
    });

    it('keeps issuing GPU work on later frames once the throwing stops', () => {
        // The property that actually matters to a user: after a transient
        // failure the viewport must come back. A latch makes every later frame
        // a no-op, so the viewport stays black until a reload.
        const h = makeHarness(() => new RangeError(HOST_OOM));
        withQuietConsole(() => { h.renderer.render(); });
        const afterThrow = h.resizeCalls();
        assert.strictEqual(afterThrow, 1, 'precondition: the throwing GPU call was reached');

        h.stopThrowing();
        withQuietConsole(() => { h.renderer.render(); });
        assert.strictEqual(
            h.resizeCalls(),
            afterThrow + 1,
            'the next frame must reach the GPU pipeline again, not be skipped by a latch',
        );
        assert.strictEqual(h.renderer.isDeviceLost(), false);
    });

    it('still contains the throw and still counts it', () => {
        const h = makeHarness(() => new RangeError(HOST_OOM));
        withQuietConsole(() => {
            assert.doesNotThrow(
                () => h.renderer.render(),
                'not latching must not mean not containing — the rAF loop still has to survive',
            );
        });
        const diag = h.renderer.getDiagnostics();
        assert.strictEqual(diag.errors, 1, 'a degraded frame is still an error, not a silent swallow');
        assert.match(diag.lastError, /mappedAtCreation/);
    });

    it('re-requests a frame, so "degrade and continue" is not "degrade and hope"', () => {
        // The host loop consumes the dirty flag BEFORE calling render(), so a
        // frame that fails has already spent its request. Without a re-request,
        // an idle viewer (no animation, no streaming, no interaction) never
        // draws again — the failed frame is the last one on screen, and the
        // "transient pressure subsides and the next frame succeeds" story that
        // justifies not latching never gets a next frame to succeed on.
        const h = makeHarness(() => new RangeError(HOST_OOM));
        h.renderer.consumeRenderRequest();
        assert.strictEqual(h.renderer.peekRenderRequest(), false, 'precondition: no request pending');

        withQuietConsole(() => { h.renderer.render(); });

        assert.strictEqual(
            h.renderer.peekRenderRequest(),
            true,
            'a degraded frame must leave a render requested',
        );
    });

    it('bounds the self-retry instead of spinning a failing frame forever', () => {
        // The other half: re-requesting unconditionally would make a
        // persistently failing path self-perpetuate one throwing frame per rAF
        // for the rest of the session. The budget caps that. Exhausting it only
        // stops US asking — the renderer is not disabled, and any external
        // dirty signal still renders (proven by the reset test below).
        const h = makeHarness(() => new RangeError(HOST_OOM));
        withQuietConsole(() => {
            for (let i = 0; i < 12; i++) {
                h.renderer.consumeRenderRequest();
                h.renderer.render();
            }
        });
        assert.strictEqual(
            h.renderer.peekRenderRequest(),
            false,
            'after the budget is spent the renderer must go quiet, not keep asking for frames',
        );
        assert.strictEqual(h.renderer.isDeviceLost(), false, 'and exhausting the budget must NOT latch');
    });

    it('restores the retry budget after any frame that succeeds', () => {
        // Reset-on-success is what makes the budget per-episode rather than
        // per-session: a blip early in a long session must not leave a later,
        // unrelated blip with nothing left to retry on.
        const h = makeHarness(() => new RangeError(HOST_OOM));
        withQuietConsole(() => {
            for (let i = 0; i < 12; i++) {
                h.renderer.consumeRenderRequest();
                h.renderer.render();
            }
        });
        assert.strictEqual(h.renderer.peekRenderRequest(), false, 'precondition: budget spent');

        // A healthy frame, then a fresh failure.
        h.stopThrowing();
        withQuietConsole(() => { h.renderer.render(); });
        h.startThrowing();
        h.renderer.consumeRenderRequest();
        withQuietConsole(() => { h.renderer.render(); });

        assert.strictEqual(
            h.renderer.peekRenderRequest(),
            true,
            'a successful frame must restore the budget for the next episode',
        );
    });

    it('never notifies onDeviceLost for a non-device throw', () => {
        // The false-toast / false-telemetry half: the viewer subscribes to this
        // to tell the user the graphics device died and to file a `device_lost`
        // exception. Firing it for an out-of-memory batch is a lie in both
        // directions.
        const h = makeHarness(() => new RangeError(HOST_OOM));
        const seen: unknown[] = [];
        h.renderer.onDeviceLost((info) => { seen.push(info); });
        withQuietConsole(() => {
            for (let i = 0; i < 5; i++) h.renderer.render();
        });
        assert.strictEqual(seen.length, 0, 'no device-loss notification for a live device');
        assert.strictEqual(
            h.resizeCalls(),
            5,
            'and every one of those frames still tried to draw — no consecutive-failure latch either',
        );
    });
});

describe('the ENCODE region gets the same discrimination as the rest of the frame (#2417)', () => {
    // #2283 taught render()'s OUTER catch to tell a device loss from host memory
    // pressure. The frame body's own try/catch — opened once the swap-chain
    // texture is acquired, covering encoder work through `submit` — was left
    // alone: it counted the error, invalidated the context, warned, and stopped.
    // A device that died mid-frame, AFTER `getCurrentTexture()` succeeded, was
    // therefore handled as if it were transient: no latch, no `onDeviceLost`,
    // no toast, and (because the host loop had already consumed the dirty flag)
    // frequently no next frame either.
    //
    // These tests drive the throw from `currentTexture.createView()`, the first
    // GPU call inside that region.

    it('latches deviceLost when the ENCODE path throws a DOMException', () => {
        const h = makeHarness(safariDeviceLost, 'encode');
        assert.strictEqual(h.renderer.isDeviceLost(), false, 'precondition: device starts alive');

        withQuietConsole(() => { h.renderer.render(); });

        assert.strictEqual(h.resizeCalls(), 1, 'precondition: the encode-region GPU call was reached');
        assert.strictEqual(
            h.renderer.isDeviceLost(),
            true,
            'a device that dies mid-frame must latch exactly as one that dies before the frame body',
        );
    });

    it('notifies onDeviceLost once, tagged as an encode-region exception', () => {
        const h = makeHarness(safariDeviceLost, 'encode');
        const seen: { message: string; reason: string }[] = [];
        h.renderer.onDeviceLost((info) => { seen.push(info); });

        withQuietConsole(() => {
            h.renderer.render();
            h.renderer.render();
            h.renderer.render();
        });

        assert.strictEqual(seen.length, 1, 'the loss is reported once per device, not once per frame');
        assert.strictEqual(
            seen[0].reason,
            'render-encode-exception',
            'the reason must distinguish a mid-frame death from one in the outer region',
        );
        assert.match(seen[0].message, /invalid state/i, 'the original GPU message must reach the listener');
    });

    it('leaves later frames as quiet skips once the encode path latched', () => {
        const h = makeHarness(safariDeviceLost, 'encode');
        withQuietConsole(() => { h.renderer.render(); });
        const afterLoss = h.resizeCalls();
        assert.strictEqual(afterLoss, 1);

        withQuietConsole(() => {
            for (let i = 0; i < 5; i++) h.renderer.render();
        });
        assert.strictEqual(
            h.resizeCalls(),
            afterLoss,
            'a latched renderer must issue no further GPU work — the whole point of latching',
        );
    });

    it('does NOT latch when the encode path throws a RangeError', () => {
        // The boundary, and it is a real one here: the encode region allocates
        // through `scene.getOrCreatePartialBatch()`, whose
        // `createBuffer({ mappedAtCreation: true })` throws exactly this on a
        // perfectly healthy device under host memory pressure.
        const h = makeHarness(() => new RangeError(HOST_OOM), 'encode');

        withQuietConsole(() => { h.renderer.render(); });

        assert.strictEqual(h.resizeCalls(), 1, 'precondition: the encode-region GPU call was reached');
        assert.strictEqual(
            h.renderer.isDeviceLost(),
            false,
            'host memory pressure inside the encode path is not a device loss',
        );
    });

    it('costs the encode RangeError one frame, not the session', () => {
        // Proven by the NEXT frame still reaching the GPU while the failure is
        // still armed: a latched renderer returns before `getCurrentTexture()`,
        // so the counter would stand still. Deliberately not "stop throwing and
        // watch it succeed" — that variant passes for a latched renderer too if
        // the stub happens to short-circuit, which is how this file's harness
        // grew its alternating canvas width in the first place.
        const h = makeHarness(() => new RangeError(HOST_OOM), 'encode');
        withQuietConsole(() => {
            for (let i = 0; i < 4; i++) h.renderer.render();
        });

        assert.strictEqual(h.resizeCalls(), 4, 'every frame must still try to draw');
        assert.strictEqual(h.renderer.getDiagnostics().errors, 4, 'and every failure must be counted');
        assert.strictEqual(h.renderer.isDeviceLost(), false);
    });

    it('re-requests a frame after an encode failure, as the outer catch does', () => {
        // The half the encode catch never had: the host loop CONSUMES the dirty
        // flag before calling render(), so a failing frame has already spent its
        // request. Without a re-request an idle viewer simply stops drawing.
        const h = makeHarness(() => new RangeError(HOST_OOM), 'encode');
        h.renderer.consumeRenderRequest();
        assert.strictEqual(h.renderer.peekRenderRequest(), false, 'precondition: no request pending');

        withQuietConsole(() => { h.renderer.render(); });

        assert.strictEqual(
            h.renderer.peekRenderRequest(),
            true,
            'a degraded encode frame must leave a render requested',
        );
    });

    it('bounds the encode self-retry too, instead of spinning forever', () => {
        // The encode catch lives INSIDE renderFrame, so a frame it contained
        // returns to render() normally. Read that as a completed frame and the
        // degraded-frame run resets on every single failure: the retry budget
        // never exhausts (one re-requested frame per rAF, for the rest of the
        // session) and no persistent-degradation report can ever fire for this
        // region. This pins that render() distinguishes "did not throw" from
        // "did not fail".
        const h = makeHarness(() => new RangeError(HOST_OOM), 'encode');
        withQuietConsole(() => {
            for (let i = 0; i < 12; i++) {
                h.renderer.consumeRenderRequest();
                h.renderer.render();
            }
        });
        assert.strictEqual(
            h.renderer.peekRenderRequest(),
            false,
            'after the budget is spent the renderer must go quiet, not keep asking for frames',
        );
        assert.strictEqual(h.renderer.isDeviceLost(), false, 'and exhausting the budget must NOT latch');
    });

    it('does not self-perpetuate: a failing encode path cannot drive the host loop forever', () => {
        // The same defect seen from the host's side, which is where it hurts.
        // The animation loop renders while a request is pending; if every
        // encode failure re-requests, the loop never stops, burning one
        // throwing frame per rAF for the rest of the session. It also crosses
        // the persistent-degradation threshold in a few hundred milliseconds
        // with no user interaction at all, turning one sustained memory-pressure
        // episode into a false "viewport wedged, reload the page" toast.
        const h = makeHarness(() => new RangeError(HOST_OOM), 'encode');
        let iterations = 0;
        withQuietConsole(() => {
            h.renderer.requestRender();
            while (h.renderer.peekRenderRequest() && iterations < 100) {
                h.renderer.consumeRenderRequest();
                h.renderer.render();
                iterations++;
            }
        });
        assert.ok(
            iterations <= 4,
            `the loop must stop within the budget (1 initial + 3 retries); it ran ${iterations} frames`,
        );
    });

    it('never notifies onDeviceLost for a non-device encode throw', () => {
        const h = makeHarness(() => new RangeError(HOST_OOM), 'encode');
        const seen: unknown[] = [];
        h.renderer.onDeviceLost((info) => { seen.push(info); });
        withQuietConsole(() => {
            for (let i = 0; i < 5; i++) h.renderer.render();
        });
        assert.strictEqual(seen.length, 0, 'no device-loss notification for a live device');
    });
});

describe('a viewport that degrades and never recovers says so (#2417)', () => {
    // Not latching is right per occurrence and blind in aggregate: the same
    // failure on frame after frame leaves a viewport that has visibly stopped,
    // with nothing on screen and nothing in error tracking to say so. The
    // renderer stays telemetry-free, so it reports through a callback in the
    // same shape as onDeviceLost.

    /** Mirrors PERSISTENT_DEGRADATION_FRAMES; imported would hide a drift. */
    const THRESHOLD = 16;

    it('fires once the degraded frames pass the threshold, and not before', () => {
        const h = makeHarness(() => new RangeError(HOST_OOM));
        const seen: { consecutiveDegradedFrames: number; detail: string; origin: string }[] = [];
        h.renderer.onPersistentRenderDegradation((info) => { seen.push(info); });

        withQuietConsole(() => {
            for (let i = 0; i < THRESHOLD - 1; i++) h.renderer.render();
        });
        assert.strictEqual(
            seen.length,
            0,
            'a handful of degraded frames is a transient spike — reporting it would be noise',
        );

        withQuietConsole(() => { h.renderer.render(); });
        assert.strictEqual(seen.length, 1, 'the crossing frame must report');
        assert.strictEqual(seen[0].consecutiveDegradedFrames, THRESHOLD);
        assert.strictEqual(seen[0].origin, 'frame');
        assert.match(seen[0].detail, /mappedAtCreation/, 'the failure text must reach the host');
    });

    it('reports once per session, not once per frame after the threshold', () => {
        const h = makeHarness(() => new RangeError(HOST_OOM));
        let calls = 0;
        h.renderer.onPersistentRenderDegradation(() => { calls++; });
        withQuietConsole(() => {
            for (let i = 0; i < THRESHOLD * 3; i++) h.renderer.render();
        });
        assert.strictEqual(calls, 1, 'one wedged viewport, one report — not one per rAF');
    });

    it('attributes a degraded ENCODE frame to the encode region', () => {
        // The origin is what tells a mid-frame failure apart from an outer-region
        // one in triage; without it both arrive as "rendering degraded".
        const h = makeHarness(() => new RangeError(HOST_OOM), 'encode');
        const seen: { origin: string }[] = [];
        h.renderer.onPersistentRenderDegradation((info) => { seen.push(info); });
        withQuietConsole(() => {
            for (let i = 0; i < THRESHOLD; i++) h.renderer.render();
        });
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].origin, 'encode');
    });

    it('never fires for a device loss — that has its own channel', () => {
        // A latched renderer stops rendering, so its degraded-frame count stops
        // moving. Firing both would double-toast one failure.
        const h = makeHarness(safariDeviceLost);
        let calls = 0;
        h.renderer.onPersistentRenderDegradation(() => { calls++; });
        withQuietConsole(() => {
            for (let i = 0; i < THRESHOLD * 3; i++) h.renderer.render();
        });
        assert.strictEqual(calls, 0, 'device loss is reported as device loss, not as degradation');
    });

    it('never fires for repeated failures that each RECOVER', () => {
        // The distinction the whole threshold rests on, and the one a
        // cumulative counter erases. Twenty separate spikes across a long
        // session, every one of which the very next frame recovered from, is a
        // healthy viewer having a bad memory day — not a stopped viewport. It
        // accumulates far more than THRESHOLD lifetime errors while never
        // running two failures back to back.
        const h = makeHarness(() => new RangeError(HOST_OOM));
        let calls = 0;
        h.renderer.onPersistentRenderDegradation(() => { calls++; });

        withQuietConsole(() => {
            for (let episode = 0; episode < THRESHOLD + 4; episode++) {
                h.startThrowing();
                h.renderer.render();   // fails
                h.stopThrowing();
                h.renderer.render();   // completes, resetting the run
            }
        });

        assert.ok(
            h.renderer.getDiagnostics().errors > THRESHOLD,
            'precondition: the session accumulated more lifetime errors than the threshold',
        );
        assert.strictEqual(
            calls,
            0,
            'a viewport that recovered every single time has not stopped — reporting it is a false positive',
        );
    });

    it('restarts the run after a recovery, so a near-miss twice over stays quiet', () => {
        // The same property one step short of the boundary: two runs of
        // THRESHOLD - 1 failures, separated by a single frame that completed.
        // Cumulatively far past the threshold; consecutively never at it.
        const h = makeHarness(() => new RangeError(HOST_OOM));
        let calls = 0;
        h.renderer.onPersistentRenderDegradation(() => { calls++; });

        withQuietConsole(() => {
            for (let run = 0; run < 2; run++) {
                h.startThrowing();
                for (let i = 0; i < THRESHOLD - 1; i++) h.renderer.render();
                h.stopThrowing();
                h.renderer.render();   // completes, resetting the run
            }
        });

        assert.ok(h.renderer.getDiagnostics().errors > THRESHOLD, 'precondition: lifetime total is past it');
        assert.strictEqual(calls, 0, 'no run ever reached the threshold, so nothing is wedged');

        // ...and the control, so this cannot pass because the callback is dead:
        // one more unbroken run DOES report.
        withQuietConsole(() => {
            h.startThrowing();
            for (let i = 0; i < THRESHOLD; i++) h.renderer.render();
        });
        assert.strictEqual(calls, 1, 'an unbroken run of THRESHOLD frames must still report');
    });

    it('stops notifying an unsubscribed listener', () => {
        const h = makeHarness(() => new RangeError(HOST_OOM));
        let calls = 0;
        const unsubscribe = h.renderer.onPersistentRenderDegradation(() => { calls++; });
        unsubscribe();
        withQuietConsole(() => {
            for (let i = 0; i < THRESHOLD * 2; i++) h.renderer.render();
        });
        assert.strictEqual(calls, 0, 'the returned unsubscribe must actually detach');
    });
});
