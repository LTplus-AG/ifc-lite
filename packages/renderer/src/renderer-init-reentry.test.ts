/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Renderer } from './index.js';

/**
 * `Renderer.init()` must release what a previous `init()` created (issue #2448).
 *
 * `init()` assigns a fresh `RenderPipeline`, `Picker`, `PostProcessor`,
 * `PointCloudRenderer`, `DeviationPipeline`, `EdlPass` and overlay layer over
 * whatever the fields already hold. Its own comment advertises a
 * `destroy()` + `init()` re-init flow, so the obvious device-loss auto-recovery
 * — call `init()` on the live instance — orphans every one of them, two GPU
 * pipelines and a glyph-atlas texture at a time.
 *
 * These drive the real `init()`. It cannot complete under node (no
 * `navigator.gpu`, and the pipeline constructors need a live device), so it is
 * allowed to reject at `WebGPUDevice.init()` — the re-entry guard runs BEFORE
 * that await, which is exactly the ordering the fix needs. The fields are
 * pre-populated with recording stand-ins, the same way this package's other
 * lifecycle tests wire stub GPU objects in by hand.
 */

/** Records whether the object was released, and by which field. */
interface Tomb { destroyed: string[] }

function poke(renderer: Renderer, field: string, value: unknown): void {
    (renderer as unknown as Record<string, unknown>)[field] = value;
}

function read(renderer: Renderer, field: string): unknown {
    return (renderer as unknown as Record<string, unknown>)[field];
}

/** The minimum canvas surface `Renderer` + `init()` read. */
function makeCanvas(): HTMLCanvasElement {
    return {
        width: 256,
        height: 256,
        getBoundingClientRect: () => ({ width: 256, height: 256 }),
    } as unknown as HTMLCanvasElement;
}

/**
 * A renderer carrying a complete set of "already initialised" GPU objects.
 *
 * `pipeline` is what the guard tests, so a harness that left it null would make
 * every assertion below vacuous — the guard would simply never fire.
 */
function makeInitialisedRenderer(): { renderer: Renderer; tomb: Tomb } {
    const renderer = new Renderer(makeCanvas());
    const tomb: Tomb = { destroyed: [] };
    const stub = (name: string) => ({
        destroy() { tomb.destroyed.push(name); },
        // `pipeline` is also asked for its sample count during a real init.
        getSampleCount: () => 1,
        // `pointCloudRenderer` is released through clear(), not destroy().
        clear() { tomb.destroyed.push(name); },
    });

    poke(renderer, 'pipeline', stub('pipeline'));
    poke(renderer, 'picker', stub('picker'));
    poke(renderer, 'postProcessor', stub('postProcessor'));
    poke(renderer, 'edlPass', stub('edlPass'));
    poke(renderer, 'skyPass', stub('skyPass'));
    poke(renderer, 'pointCloudRenderer', stub('pointCloudRenderer'));
    poke(renderer, 'deviationPipeline', stub('deviationPipeline'));

    // The overlay layer owns its GPU objects behind RendererOverlays.destroy().
    const overlays = read(renderer, 'overlays') as Record<string, unknown>;
    overlays['sectionPlaneRenderer'] = { destroy() { tomb.destroyed.push('sectionPlaneRenderer'); } };
    overlays['section2DOverlayRenderer'] = { dispose() { tomb.destroyed.push('section2DOverlay'); } };

    // The glyph atlas is NOT owned by either of the two above: it belongs to
    // `SymbolicTextPipeline`, which `RendererOverlays` composes as `symbolic`
    // (`SymbolicOverlays`) and releases through a THIRD call in its `destroy()`.
    // Instrumenting only the two renderers above would leave a test that stays
    // green after `this.symbolic.destroy()` is deleted — i.e. green while the
    // atlas texture this file's own doc comment names is orphaned.
    const symbolic = overlays['symbolic'] as Record<string, unknown>;
    symbolic['fillPipeline'] = { destroy() { tomb.destroyed.push('symbolicFillPipeline'); } };
    symbolic['textPipeline'] = { destroy() { tomb.destroyed.push('symbolicTextPipeline'); } };

    return { renderer, tomb };
}

/** Let every already-queued microtask run. */
async function drainMicrotasks(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Did `whenReady()` settle within the microtasks already queued? */
async function whenReadyResolves(renderer: Renderer): Promise<boolean> {
    let resolved = false;
    void renderer.whenReady().then(() => { resolved = true; });
    await drainMicrotasks();
    return resolved;
}

/**
 * A device stand-in that reports itself initialised and never completes a NEW
 * init. It parks the renderer inside the window this file is about: `init()` has
 * been called, its queued body may or may not have started, and nothing has
 * reached `markReady()` yet.
 */
function pokeHangingDevice(renderer: Renderer): void {
    poke(renderer, 'device', {
        isInitialized: () => true,
        onDeviceLost: () => { /* no loss to report from a stub */ },
        init: () => new Promise<void>(() => { /* never settles */ }),
        destroy: () => { /* nothing real to release */ },
    });
}

/** Run `init()` and swallow the expected "no WebGPU here" rejection. */
async function initExpectingNoWebGPU(renderer: Renderer): Promise<void> {
    await assert.rejects(
        () => renderer.init(),
        'precondition: init() cannot complete under node, so only the pre-await guard is exercised',
    );
}

describe('a second init() releases the first init()\'s GPU objects (#2448)', () => {
    it('destroys every pipeline the previous init() created', async () => {
        const { renderer, tomb } = makeInitialisedRenderer();
        assert.deepStrictEqual(tomb.destroyed, [], 'precondition: nothing released yet');

        await initExpectingNoWebGPU(renderer);

        for (const name of [
            'pipeline',
            'picker',
            'postProcessor',
            'edlPass',
            'skyPass',
            'pointCloudRenderer',
            'deviationPipeline',
        ]) {
            assert.ok(tomb.destroyed.includes(name), `${name} was orphaned by the re-init`);
        }
    });

    it('releases the overlay layer, including its glyph atlas owner', async () => {
        const { renderer, tomb } = makeInitialisedRenderer();
        await initExpectingNoWebGPU(renderer);
        assert.ok(tomb.destroyed.includes('sectionPlaneRenderer'), 'the section gizmo was orphaned');
        assert.ok(tomb.destroyed.includes('section2DOverlay'), 'the 2D overlay / cap renderer was orphaned');
        // The glyph atlas texture lives on `SymbolicTextPipeline`, which the
        // overlay facade releases via `this.symbolic.destroy()` — a separate
        // call from the two above, and the one the changeset names.
        assert.ok(
            tomb.destroyed.includes('symbolicTextPipeline'),
            'the glyph atlas owner (SymbolicTextPipeline) was orphaned',
        );
        assert.ok(
            tomb.destroyed.includes('symbolicFillPipeline'),
            'the symbolic fill pipeline was orphaned',
        );
    });

    it('clears the fields, so nothing can be released twice', async () => {
        const { renderer } = makeInitialisedRenderer();
        await initExpectingNoWebGPU(renderer);
        assert.strictEqual(read(renderer, 'pipeline'), null);
        assert.strictEqual(read(renderer, 'picker'), null);
        assert.strictEqual(read(renderer, 'pointCloudRenderer'), null);
    });

    it('re-arms whenReady(), so a caller cannot resolve against dead GPU objects', async () => {
        const { renderer } = makeInitialisedRenderer();
        poke(renderer, 'ready', true);

        await initExpectingNoWebGPU(renderer);

        let resolved = false;
        void renderer.whenReady().then(() => { resolved = true; });
        await Promise.resolve();
        assert.strictEqual(resolved, false, 'whenReady() must wait for the NEW device, not the destroyed one');
    });

    it('does not destroy anything on a FIRST init()', async () => {
        // The boundary, and the control: an unconditional teardown would tear
        // down a renderer that had never been initialised, and would make the
        // assertions above pass for the wrong reason.
        const renderer = new Renderer(makeCanvas());
        let sceneClears = 0;
        const scene = read(renderer, 'scene') as Record<string, unknown>;
        const realClear = scene['clear'] as () => void;
        scene['clear'] = function patched(this: unknown) { sceneClears++; return realClear.call(this); };

        await initExpectingNoWebGPU(renderer);

        assert.strictEqual(sceneClears, 0, 'a first init() must not run destroy()');
    });
});

/**
 * Overlapping `init()` calls (issue #2448, the concurrent half).
 *
 * The re-entry guard above keys on `pipeline`, which marks a COMPLETED init.
 * While the first call is parked on `await this.device.init(...)` that field is
 * still null, so a second call walks straight past the guard, and both go on to
 * allocate a full set of GPU objects — the first set orphaned, which is exactly
 * the leak the guard exists to close. `init()` therefore queues: the second call
 * waits for the first to settle and then runs in full, which reduces the
 * concurrent case to the sequential one the tests above already pin.
 *
 * The device is stubbed with a gate rather than a real GPU: the property under
 * test is purely the ORDER in which `device.init()` is entered, and that is
 * observable without one. What a completed init then destroys is covered above.
 */
describe('overlapping init() calls are serialised (#2448)', () => {
    it('starts the second device init only after the first has settled', async () => {
        const renderer = new Renderer(makeCanvas());

        let deviceInits = 0;
        let openGate: () => void = () => {};
        const gate = new Promise<void>((resolve) => { openGate = resolve; });
        poke(renderer, 'device', {
            onDeviceLost: () => { /* the real subscription needs no stand-in here */ },
            init: async () => {
                deviceInits++;
                // Only the FIRST call is held, so the second is free to run the
                // moment the queue lets it — if it is ever let past at all.
                if (deviceInits === 1) await gate;
                throw new Error('no WebGPU in node');
            },
        });

        // Attach the outcome handlers immediately: these reject by design, and
        // a floating rejection would be reported against an unrelated test.
        const first = renderer.init().then(() => 'resolved', () => 'rejected');
        const second = renderer.init().then(() => 'resolved', () => 'rejected');

        // Drain every microtask already queued. Unserialised, both calls have
        // reached `device.init()` well inside this window.
        for (let i = 0; i < 20; i++) await Promise.resolve();
        assert.strictEqual(deviceInits, 1, 'the second init() must not run while the first is in flight');

        openGate();

        assert.strictEqual(await first, 'rejected', 'precondition: the stub device cannot init under node');
        assert.strictEqual(await second, 'rejected');
        // Serialising must not SWALLOW the second call: a queue that coalesced
        // it into the first would leave this at 1, and a caller asking for a
        // fresh device after a loss would silently get nothing.
        assert.strictEqual(deviceInits, 2, 'the second init() must still run, after the first, not instead of it');
    });
});

/**
 * Readiness must be revoked SYNCHRONOUSLY by `init()` (issue #2448, the
 * microtask half).
 *
 * Serialising `init()` moved its whole body behind `initChain.then(...)`, so it
 * no longer runs up to the first `await` before returning. The `ready = false`
 * that the re-entry fix added therefore no longer takes effect before `init()`
 * hands control back, and `renderer.init(); await renderer.whenReady();`
 * resolves against the outgoing device — the exact hazard that line exists to
 * close, reopened by the queue.
 *
 * The window is not observable after awaiting `init()`, which is why the
 * re-entry tests above cannot see it: every assertion here is made while the
 * queued body has not yet published a new device.
 */
describe('init() revokes readiness before it queues its body (#2448)', () => {
    it('isReady() is false the instant init() returns', () => {
        const { renderer } = makeInitialisedRenderer();
        pokeHangingDevice(renderer);
        poke(renderer, 'ready', true);
        assert.strictEqual(
            renderer.isReady(),
            true,
            'precondition: the harness is a fully initialised renderer, or the assertion below is vacuous',
        );

        void renderer.init();

        assert.strictEqual(
            renderer.isReady(),
            false,
            'isReady() reported the OUTGOING device as usable inside the init() microtask window',
        );
    });

    it('whenReady() waits instead of resolving against the outgoing device', async () => {
        const { renderer } = makeInitialisedRenderer();
        pokeHangingDevice(renderer);
        poke(renderer, 'ready', true);
        assert.strictEqual(
            await whenReadyResolves(renderer),
            true,
            'precondition: whenReady() resolves while the renderer really is ready',
        );

        void renderer.init();

        assert.strictEqual(
            await whenReadyResolves(renderer),
            false,
            'whenReady() resolved against GPU objects the queued init() is about to destroy',
        );
    });

    it('destroy() re-arms whenReady() on its own', async () => {
        // init() is not the only way the device goes away: a host that tears the
        // renderer down directly must not leave whenReady() resolving forever.
        const { renderer } = makeInitialisedRenderer();
        poke(renderer, 'ready', true);
        assert.strictEqual(await whenReadyResolves(renderer), true, 'precondition: ready before destroy()');

        renderer.destroy();

        assert.strictEqual(
            await whenReadyResolves(renderer),
            false,
            'whenReady() resolved after destroy() released every GPU object',
        );
    });

    it('an init() still queued keeps the one ahead of it from publishing readiness', async () => {
        // The queue can let an init COMPLETE while a later one is still waiting
        // its turn. That later call will destroy() everything the first built, so
        // the first must not announce a ready device in between.
        const renderer = new Renderer(makeCanvas());
        const gates: Array<() => void> = [];
        let started = 0;
        const markReady = read(renderer, 'markReady') as (generation: number) => void;
        // Stand in for the body only: what a real init allocates is covered
        // above, and the property under test is purely which generation wins.
        poke(renderer, 'initOnce', async (generation: number) => {
            started++;
            await new Promise<void>((resolve) => { gates.push(resolve); });
            markReady.call(renderer, generation);
        });

        const first = renderer.init();
        const second = renderer.init();
        await drainMicrotasks();
        assert.strictEqual(started, 1, 'precondition: the queue holds the second call back');

        gates[0]();
        await first;
        assert.strictEqual(started, 2, 'precondition: the second call ran once the first settled');
        assert.strictEqual(
            await whenReadyResolves(renderer),
            false,
            'the superseded init() published readiness while a queued init() was still pending',
        );

        gates[1]();
        await second;
        assert.strictEqual(
            await whenReadyResolves(renderer),
            true,
            'the LAST init() must still publish readiness, or whenReady() never resolves again',
        );
    });
    it('resolves a waiter that parked while the init was still in flight', async () => {
        // `whenReady()` has two paths: a fast path for an already-ready renderer,
        // and a parked waiter for one still initialising. Every other test in this
        // file observes readiness AFTER it settles, so they all take the fast path
        // and none of them touches `markReady()`'s flush loop — deleting that loop
        // leaves this whole file green while the real consumer (a caller awaiting
        // `whenReady()` during startup) waits forever.
        const renderer = new Renderer(makeCanvas());
        const markReady = read(renderer, 'markReady') as (generation: number) => void;
        const gates: Array<() => void> = [];
        poke(renderer, 'initOnce', async (generation: number) => {
            await new Promise<void>((resolve) => { gates.push(resolve); });
            markReady.call(renderer, generation);
        });

        const init = renderer.init();
        await drainMicrotasks();

        let resolved = false;
        void renderer.whenReady().then(() => { resolved = true; });
        await drainMicrotasks();
        assert.strictEqual(resolved, false, 'precondition: the waiter parks while the init is in flight');
        assert.strictEqual(
            (read(renderer, 'readyWaiters') as Array<() => void>).length,
            1,
            'precondition: the waiter is parked rather than dropped',
        );

        gates[0]();
        await init;
        await drainMicrotasks();
        assert.strictEqual(resolved, true, 'a waiter parked before the init completed was never resolved');
    });
});
