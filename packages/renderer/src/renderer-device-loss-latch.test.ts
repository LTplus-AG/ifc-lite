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
 */

/** Verbatim Safari 26.5 wording from the PostHog frames in #2229. */
const SAFARI_LOST = "InvalidStateError: The object is in an invalid state.";

interface Harness {
    renderer: Renderer;
    /** how many times the (throwing) pipeline.resize was reached */
    resizeCalls(): number;
    /** stop throwing, so a later frame could succeed if the latch let it */
    stopThrowing(): void;
}

/**
 * A renderer wired to a stub device whose canvas reports a CSS size that
 * differs from its backing store, so every frame takes the
 * `dimensionsChanged` branch and calls `pipeline.resize()`.
 */
function makeHarness(): Harness {
    let resizeCalls = 0;
    let throwing = true;

    const canvas = {
        width: 0,
        height: 0,
        getBoundingClientRect: () => ({ width: 256, height: 256 }),
    } as unknown as HTMLCanvasElement;

    const renderer = new Renderer(canvas);

    // Minimal live-device stub: enough for render() to get past its entry
    // guards and reach the resize branch.
    const wdev = renderer['device'] as unknown as Record<string, unknown>;
    wdev['device'] = {
        limits: { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024 },
    };
    wdev['context'] = { configure() { /* no-op */ }, getCurrentTexture: () => null };
    wdev['canvas'] = canvas;
    wdev['contextConfigured'] = true;

    (renderer as unknown as Record<string, unknown>)['pipeline'] = new Proxy(
        {} as Record<string | symbol, unknown>,
        {
            get(_t, prop) {
                if (prop === 'resize') {
                    return () => {
                        resizeCalls++;
                        // Exactly what Safari does on a dead device: a
                        // synchronous throw from createTexture.
                        if (throwing) throw new Error(SAFARI_LOST);
                    };
                }
                if (prop === 'needsResize') return () => false;
                if (prop === 'getSampleCount') return () => 1;
                return () => ({});
            },
        },
    );

    return {
        renderer,
        resizeCalls: () => resizeCalls,
        stopThrowing() { throwing = false; },
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
