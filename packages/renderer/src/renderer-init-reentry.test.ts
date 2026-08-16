/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { Renderer } from './index.js';

/**
 * `Renderer.init()` must release what a previous `init()` created (issue #2448).
 *
 * `init()` assigns a fresh `RenderPipeline`, `Picker`, `PostProcessor`,
 * `PointCloudRenderer`, `DeviationComputer`, `EdlPass` and overlay layer over
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
    // `deviationComputer` is the `DeviationComputer` collaborator (#2425)
    // that now owns the pipeline + BVH cache; `teardown()` calls its
    // `destroy()` unconditionally, so stubbing the whole field (like every
    // other collaborator here) still exercises the re-init release path.
    poke(renderer, 'deviationComputer', stub('deviationComputer'));

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

/**
 * A bounded wait wide enough to be evidence of a NEGATIVE: microtasks, timer
 * callbacks and a real elapsed timeout. "The frame never resumed" is only worth
 * asserting if a frame that DOES resume would have resumed inside this window,
 * which the control assertion in the test below establishes.
 */
async function drainMacrotasks(): Promise<void> {
    for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
    for (let i = 0; i < 25; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Did `whenReady()` RESOLVE within the microtasks already queued?
 *
 * A rejection counts as "no" and is swallowed here: on a destroyed renderer the
 * wait fails by design, and an unhandled rejection would be reported against
 * whichever test happens to be running. Tests about the rejection itself assert
 * on it directly rather than through this helper.
 */
async function whenReadyResolves(renderer: Renderer): Promise<boolean> {
    let resolved = false;
    void renderer.whenReady().then(() => { resolved = true; }, () => { /* not a resolve */ });
    await drainMicrotasks();
    return resolved;
}

/** How a `whenReady()` waiter ended up: settled either way, or still parked. */
type WaiterOutcome = 'resolved' | 'pending' | Error;

/** The rejection `destroy()` hands to a parked waiter. */
async function settleWhenReady(renderer: Renderer): Promise<WaiterOutcome> {
    let outcome: WaiterOutcome = 'pending';
    void renderer.whenReady().then(
        () => { outcome = 'resolved'; },
        (err: Error) => { outcome = err; },
    );
    await drainMicrotasks();
    return outcome;
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
        // `[] as string[]` (not a bare `[]`): `assert.deepStrictEqual` is an
        // `asserts actual is T` signature, so a bare literal narrows
        // `tomb.destroyed` to `never[]` for the rest of the test and the
        // `includes(name)` calls below stop type-checking (TS2345).
        assert.deepStrictEqual(tomb.destroyed, [] as string[], 'precondition: nothing released yet');

        await initExpectingNoWebGPU(renderer);

        for (const name of [
            'pipeline',
            'picker',
            'postProcessor',
            'edlPass',
            'skyPass',
            'pointCloudRenderer',
            'deviationComputer',
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

/**
 * `destroy()` while an `init()` is in flight (issue #2465).
 *
 * The init is parked on `await device.init(...)`. `destroy()` revoking `ready`
 * is not enough on its own: the parked init resumes afterwards, and unless its
 * generation has been invalidated it allocates a complete replacement GPU stack
 * that nothing references and re-publishes readiness against a renderer the host
 * has already torn down.
 *
 * This is reachable from the viewer, not only in theory. `Viewport`'s effect
 * cleanup calls `renderer.destroy()`, and React StrictMode unmounts every dev
 * mount while the very first `init()` is still awaiting its device; the
 * mobile/desktop layout swap does the same in production. A consumer that
 * captured the renderer BEFORE the teardown then observes the republish —
 * `useIfcLoader` holds it in a local const across `await renderer.whenReady()`
 * and streams a point cloud into whatever that resolves against.
 */
describe('destroy() invalidates an init still in flight (#2465)', () => {
    it('stops the aborted init from allocating a replacement GPU stack', async () => {
        const renderer = new Renderer(makeCanvas());
        let openGate: () => void = () => {};
        const gate = new Promise<void>((resolve) => { openGate = resolve; });
        // The first thing the allocation phase asks the device for, and the last
        // observable before the pipeline constructors (which need a real GPU).
        let maxDimCalls = 0;
        let deviceDestroys = 0;
        poke(renderer, 'device', {
            isInitialized: () => true,
            onDeviceLost: () => { /* no loss to report from a stub */ },
            init: async () => { await gate; },
            destroy: () => { deviceDestroys++; },
            getMaxTextureDimension: () => { maxDimCalls++; return 8192; },
            getDevice: () => ({}),
            getFormat: () => 'bgra8unorm',
        });

        // Rejects if the abort is missing (the pipeline constructors cannot run
        // under node) — attach the handler up front so that is reported here.
        const init = renderer.init().then(() => 'resolved', () => 'rejected');
        await drainMicrotasks();
        assert.strictEqual(maxDimCalls, 0, 'precondition: the init is parked inside device.init()');

        renderer.destroy();
        const destroysBeforeResume = deviceDestroys;
        assert.strictEqual(destroysBeforeResume, 1, 'precondition: the host teardown released the device');

        openGate();
        await init;
        await drainMicrotasks();

        assert.strictEqual(
            maxDimCalls,
            0,
            'the aborted init allocated a full GPU stack after destroy() — nothing references it, and no second teardown runs',
        );
        assert.strictEqual(
            deviceDestroys,
            destroysBeforeResume + 1,
            'the device the aborted init brought up was never released',
        );
    });

    it('stops the aborted init from re-publishing readiness', async () => {
        const renderer = new Renderer(makeCanvas());
        const markReady = read(renderer, 'markReady') as (generation: number) => void;
        const gates: Array<() => void> = [];
        // Stands in for the tail of a real init: the allocation cannot run under
        // node, and the property under test is purely which generation wins.
        poke(renderer, 'initOnce', async (generation: number) => {
            await new Promise<void>((resolve) => { gates.push(resolve); });
            markReady.call(renderer, generation);
        });

        const init = renderer.init();
        await drainMicrotasks();

        // A consumer that captured the renderer before the teardown and parked
        // on whenReady() — the shape useIfcLoader uses for a point-cloud drop.
        // The rejection handler is not decoration: destroy() fails this waiter,
        // and an unhandled rejection would be reported against another test.
        let resolved = false;
        void renderer.whenReady().then(() => { resolved = true; }, () => { /* failed, not resolved */ });
        await drainMicrotasks();
        assert.strictEqual(resolved, false, 'precondition: the waiter parks while the init is in flight');

        renderer.destroy();

        gates[0]();
        await init;
        await drainMicrotasks();

        assert.strictEqual(
            read(renderer, 'ready'),
            false,
            'the in-flight init re-published readiness after the renderer was destroyed',
        );
        assert.strictEqual(
            resolved,
            false,
            'a parked whenReady() waiter was resolved against a destroyed renderer',
        );
    });

    it('a re-init\'s own teardown does not invalidate the init running it', async () => {
        // The control for the fix above, and the trap it has to avoid: initOnce()
        // tears the previous init down before building its own. Route that
        // teardown through the invalidating path and every init cancels itself,
        // so nothing ever becomes ready again — a deadlock that the two tests
        // above would not notice.
        const { renderer } = makeInitialisedRenderer();
        const markReady = read(renderer, 'markReady') as (generation: number) => void;
        const realInitOnce = read(renderer, 'initOnce') as (generation: number) => Promise<void>;
        let carried = -1;
        poke(renderer, 'initOnce', (generation: number) => {
            carried = generation;
            return realInitOnce.call(renderer, generation);
        });

        await initExpectingNoWebGPU(renderer);
        assert.ok(carried >= 0, 'precondition: the queued body ran and carried a generation');
        assert.strictEqual(
            read(renderer, 'pipeline'),
            null,
            'precondition: the re-init tore the previous init down, which is the path under test',
        );

        // The generation this init carries must still be the current one, so the
        // completion it is on its way to would be accepted.
        markReady.call(renderer, carried);
        assert.strictEqual(
            await whenReadyResolves(renderer),
            true,
            'a re-init invalidated its own generation, so whenReady() can never resolve again',
        );
    });
});

/**
 * `destroy()` FAILS a parked `whenReady()` waiter (issue #2465, the caller half).
 *
 * Withholding the resolve is only half a contract. The other half is what the
 * caller does next, and "neither resolve nor reject" is not an outcome an
 * `await` can act on: the async frame is suspended for the lifetime of the page,
 * holding everything it captured, with no error anywhere.
 *
 * It is not recoverable later, either. `apps/viewer`'s `Viewport` builds a NEW
 * `Renderer` in the effect that mounts the canvas and destroys the old one in
 * that effect's cleanup, so a `destroy()` there is FINAL for the instance a
 * consumer captured — nothing will ever call `init()` on it again. (A library
 * consumer that re-inits the SAME instance is the other case, and there the
 * waiters must survive; the test at the end pins that.) The reachable path is
 * the one #2465 already documents: `useIfcLoader` captures the renderer in a
 * local const and awaits `whenReady()` before streaming a point cloud, and the
 * mobile/desktop layout swap unmounts the viewport at any moment.
 */
describe('destroy() fails a parked whenReady() waiter (#2465)', () => {
    it('rejects the waiter with a discriminable error and drops it from the queue', async () => {
        const renderer = new Renderer(makeCanvas());
        pokeHangingDevice(renderer);
        void renderer.init().catch(() => { /* the stub device never settles */ });
        await drainMicrotasks();

        let outcome: WaiterOutcome = 'pending';
        // Read through this rather than touching `outcome` directly: the only
        // writes are from the promise callbacks, which TS's control-flow
        // analysis cannot see, so a direct read still carries the initialiser's
        // `'pending'` narrowing and `instanceof Error` looks impossible (TS2358).
        const readOutcome = (): WaiterOutcome => outcome;
        void renderer.whenReady().then(() => { outcome = 'resolved'; }, (err: Error) => { outcome = err; });
        await drainMicrotasks();
        assert.strictEqual(outcome, 'pending', 'precondition: the waiter parks while the init is in flight');
        assert.strictEqual(
            (read(renderer, 'readyWaiters') as unknown[]).length,
            1,
            'precondition: the waiter is parked rather than dropped',
        );

        renderer.destroy();
        await drainMicrotasks();

        const settled = readOutcome();
        assert.ok(settled instanceof Error, 'the waiter was left pending forever instead of being failed');
        assert.strictEqual(
            (settled as Error).name,
            'RendererDestroyedError',
            'the rejection must be discriminable — callers have to tell "gone away" from "load failed"',
        );
        assert.strictEqual(
            (read(renderer, 'readyWaiters') as unknown[]).length,
            0,
            'the failed waiter was left in the queue, so the renderer still retains the caller\'s closure',
        );
    });

    it('lets the awaiting frame RESUME, rather than suspending it for the page\'s lifetime', async () => {
        // The property that matters to a consumer is not the promise's state, it
        // is whether the code after `await` ever runs again. Asserted over a
        // bounded wait that spans microtasks, timer callbacks and real elapsed
        // time; the control at the end proves that window is wide enough to see
        // a resume that does happen, so "never resumed" is not just "not yet".
        const renderer = new Renderer(makeCanvas());
        pokeHangingDevice(renderer);
        void renderer.init().catch(() => { /* the stub device never settles */ });
        await drainMicrotasks();

        // The exact shape of apps/viewer's point-cloud drop: capture the
        // renderer into a local, await readiness, then use the local.
        const captured = renderer;
        let outcome = 'suspended';
        void (async () => {
            try {
                await captured.whenReady();
                outcome = 'resumed-ready';
            } catch {
                outcome = 'resumed-failed';
            }
        })();
        await drainMacrotasks();
        assert.strictEqual(outcome, 'suspended', 'precondition: the frame is parked while the init is in flight');

        renderer.destroy();
        await drainMacrotasks();
        assert.strictEqual(
            outcome,
            'resumed-failed',
            'the caller\'s async frame never resumed after destroy() — it is suspended for the lifetime of the page',
        );

        // Control: the same bounded wait DOES observe a resume, so the assertion
        // above is about the frame and not about the size of the window.
        const control = new Renderer(makeCanvas());
        pokeHangingDevice(control);
        let controlOutcome = 'suspended';
        void (async () => {
            try {
                await control.whenReady();
                controlOutcome = 'resumed-ready';
            } catch {
                controlOutcome = 'resumed-failed';
            }
        })();
        await drainMicrotasks();
        assert.strictEqual(controlOutcome, 'suspended', 'precondition: the control frame parks too');
        (read(control, 'markReady') as (generation: number) => void).call(control, 0);
        await drainMacrotasks();
        assert.strictEqual(controlOutcome, 'resumed-ready', 'control: this wait can observe a resume');
    });

    it('rejects a wait requested AFTER destroy(), instead of parking it', async () => {
        // The same hazard through the other door: a caller that asks a moment
        // later would otherwise park on a renderer that can never publish
        // readiness, which is the identical permanent suspension.
        const { renderer } = makeInitialisedRenderer();
        poke(renderer, 'ready', true);
        assert.strictEqual(await whenReadyResolves(renderer), true, 'precondition: ready before destroy()');

        renderer.destroy();

        const outcome = await settleWhenReady(renderer);
        assert.ok(outcome instanceof Error, 'whenReady() parked a NEW waiter on a destroyed renderer');
        assert.strictEqual((outcome as Error).name, 'RendererDestroyedError');
        assert.strictEqual(
            (read(renderer, 'readyWaiters') as unknown[]).length,
            0,
            'a rejected wait must not leave a waiter behind',
        );
    });

    it('re-arms after a later init(), so destroy() is not a permanent verdict', async () => {
        // The boundary of the flag above: a library consumer that re-initialises
        // the SAME instance after destroy() must get a working whenReady() back,
        // not a renderer that rejects for ever.
        const renderer = new Renderer(makeCanvas());
        renderer.destroy();
        assert.ok(
            (await settleWhenReady(renderer)) instanceof Error,
            'precondition: whenReady() rejects on the destroyed instance',
        );

        const markReady = read(renderer, 'markReady') as (generation: number) => void;
        // Stands in for the allocation, which cannot run under node; the
        // property under test is purely that the wait parks and then resolves.
        poke(renderer, 'initOnce', async (generation: number) => { markReady.call(renderer, generation); });

        const init = renderer.init();
        const outcome = settleWhenReady(renderer);
        await init;

        assert.strictEqual(await outcome, 'resolved', 'a re-init left whenReady() rejecting from the old destroy()');
    });

    it('the teardown a re-init runs does NOT fail the waiters parked for it', async () => {
        // The reason the rejection lives in destroy() and not in teardown().
        // initOnce() tears the PREVIOUS init's objects down as part of its own
        // re-init; a caller parked across that is waiting for the init doing the
        // tearing down, and failing it there would turn every re-init into an
        // error for everyone waiting on it.
        const { renderer } = makeInitialisedRenderer();
        const markReady = read(renderer, 'markReady') as (generation: number) => void;
        const teardown = read(renderer, 'teardown') as () => void;

        let outcome: 'resolved' | 'pending' | Error = 'pending';
        void renderer.whenReady().then(() => { outcome = 'resolved'; }, (err: Error) => { outcome = err; });
        await drainMicrotasks();
        assert.strictEqual(outcome, 'pending', 'precondition: the waiter is parked');

        teardown.call(renderer);
        await drainMicrotasks();
        assert.strictEqual(outcome, 'pending', 'a re-init\'s teardown failed a waiter that belongs to that re-init');
        assert.strictEqual(
            (read(renderer, 'readyWaiters') as unknown[]).length,
            1,
            'the waiter must survive the teardown to be flushed by the init running it',
        );

        markReady.call(renderer, read(renderer, 'initGeneration') as number);
        await drainMicrotasks();
        assert.strictEqual(outcome, 'resolved', 'the re-init could no longer resolve the waiter it kept');
    });
});

/**
 * A GPU device loss revokes readiness too — the same lie through a third door.
 *
 * `init()` and `destroy()` both revoke readiness because the objects it
 * describes are going away. An involuntary loss (driver reset, VRAM
 * exhaustion, GPU-process crash) kills exactly the same objects, but nothing on
 * that path touched the readiness state: `render()` became a no-op while
 * `isReady()` kept answering true and `whenReady()` kept resolving.
 *
 * The waiter half is not hypothetical. `init()` subscribes to the device's loss
 * signal BEFORE awaiting it, precisely so a loss during initialisation is not
 * missed — so a loss can land while a caller is parked in `whenReady()`, and
 * the init that resumes afterwards would flush that waiter against a device
 * that had already died.
 *
 * The latch itself, and the `isReady()` half driven through a real frame, live
 * in `renderer-device-loss-latch.test.ts`; these are about the wait.
 */
describe('a device loss revokes readiness (#2464 review)', () => {
    /** Silence the once-per-loss console output the handler emits. */
    function withQuietConsole<T>(run: () => T): T {
        const warn = mock.method(console, 'warn', () => undefined);
        const error = mock.method(console, 'error', () => undefined);
        try {
            return run();
        } finally {
            warn.mock.restore();
            error.mock.restore();
        }
    }

    /**
     * A device stand-in that hands its loss subscription back to the test, so
     * the loss arrives through the same door Chromium's `device.lost` uses —
     * `initOnce()` calls `device.onDeviceLost(...)` before awaiting the device
     * — rather than by calling the private handler.
     *
     * `init()` rejects, as it does under node, which leaves the renderer in the
     * state a host retries from: subscribed, not ready, nothing published.
     */
    function pokeLosableDevice(renderer: Renderer): { lose: () => void } {
        let handler: ((info: { message: string; reason: string }) => void) | null = null;
        poke(renderer, 'device', {
            isInitialized: () => true,
            onDeviceLost: (cb: (info: { message: string; reason: string }) => void) => { handler = cb; },
            init: async () => { throw new Error('no WebGPU in node'); },
            destroy: () => { /* nothing real to release */ },
        });
        return {
            lose: () => {
                assert.ok(handler, 'precondition: init() subscribed to the device loss signal');
                withQuietConsole(() => {
                    handler!({ message: 'driver reset', reason: 'device-lost' });
                });
            },
        };
    }

    it('fails a waiter parked when the device dies, instead of flushing it later', async () => {
        const renderer = new Renderer(makeCanvas());
        const device = pokeLosableDevice(renderer);
        await initExpectingNoWebGPU(renderer);

        let outcome: WaiterOutcome = 'pending';
        // See the note on the other `readOutcome` above (TS2358).
        const readOutcome = (): WaiterOutcome => outcome;
        void renderer.whenReady().then(() => { outcome = 'resolved'; }, (err: Error) => { outcome = err; });
        await drainMicrotasks();
        assert.strictEqual(outcome, 'pending', 'precondition: the waiter parks on a renderer that is not ready yet');

        device.lose();
        await drainMicrotasks();

        const settled = readOutcome();
        assert.ok(settled instanceof Error, 'the waiter was left parked on a device that no longer exists');
        assert.strictEqual((settled as Error).name, 'RendererDeviceLostError');
        assert.strictEqual(
            (read(renderer, 'readyWaiters') as unknown[]).length,
            0,
            'the failed waiter was left in the queue, so the renderer still retains the caller\'s closure',
        );
    });

    it('keeps rejecting after the init the loss landed in publishes readiness', async () => {
        // The ordering that makes the check load-bearing rather than decorative.
        // A loss during init leaves BOTH flags set: the init runs to completion
        // and marks the renderer ready, so a `whenReady()` that consulted
        // `ready` first would go straight back to resolving against the dead
        // device one microtask after the loss was reported.
        const renderer = new Renderer(makeCanvas());
        const device = pokeLosableDevice(renderer);
        await initExpectingNoWebGPU(renderer);
        device.lose();

        const markReady = read(renderer, 'markReady') as (generation: number) => void;
        markReady.call(renderer, read(renderer, 'initGeneration') as number);
        assert.strictEqual(read(renderer, 'ready'), true, 'precondition: the init published readiness');

        const outcome = await settleWhenReady(renderer);
        assert.ok(outcome instanceof Error, 'whenReady() resolved against the device that was lost mid-init');
        assert.strictEqual((outcome as Error).name, 'RendererDeviceLostError');
    });

    it('re-arms whenReady() the instant init() is called, with no second reset', async () => {
        // The recovery shape `init()` already revokes readiness synchronously
        // for: `renderer.init(); await renderer.whenReady();`. The queued body
        // is what clears the loss latch, so a rejection keyed on the raw flag
        // fires inside that microtask window and fails the very caller who is
        // bringing the renderer back up. Keying it to the lifecycle generation
        // — which `init()` bumps synchronously — re-arms the wait at the call,
        // and the body's own clear then needs no second reset.
        const renderer = new Renderer(makeCanvas());
        const device = pokeLosableDevice(renderer);
        await initExpectingNoWebGPU(renderer);
        device.lose();
        assert.ok(
            (await settleWhenReady(renderer)) instanceof Error,
            'precondition: whenReady() rejects while the loss stands',
        );

        // Called synchronously, in the same turn as init() — before the queued
        // body has run at all.
        const recovery = renderer.init().then(() => 'resolved', () => 'rejected');
        const parked = settleWhenReady(renderer);

        assert.strictEqual(
            await parked,
            'pending',
            'a caller recovering with init() was rejected by the loss that init is clearing',
        );
        assert.strictEqual(await recovery, 'rejected', 'precondition: the stub device cannot init under node');
        assert.strictEqual(
            renderer.isDeviceLost(),
            false,
            'the queued body must clear the latch itself — the re-arm above is not a substitute for it',
        );

        // ...and the wait still works afterwards, so the re-arm is not a
        // permanently parked promise.
        const markReady = read(renderer, 'markReady') as (generation: number) => void;
        markReady.call(renderer, read(renderer, 'initGeneration') as number);
        assert.strictEqual(
            await settleWhenReady(renderer),
            'resolved',
            'a renderer brought back up after a loss can never publish readiness again',
        );
    });

    it('does not strand a loss that latched inside the init() microtask window', async () => {
        // The boundary of keying the rejection to a generation. A loss can land
        // AFTER init() has bumped the generation and BEFORE its queued body
        // runs — the window that exists for every init behind a queue — so the
        // latch is stamped with the generation that is about to clear it. The
        // rejection therefore cannot rest on the stamp alone: the flag the
        // queued body clears has to be part of the test, or this renderer
        // rejects every wait for the rest of its life despite a healthy device.
        const renderer = new Renderer(makeCanvas());
        const device = pokeLosableDevice(renderer);
        await initExpectingNoWebGPU(renderer);

        const second = renderer.init().then(() => 'resolved', () => 'rejected');
        device.lose();   // same turn as init(): stamped with the NEW generation
        assert.strictEqual(renderer.isDeviceLost(), true, 'precondition: the loss latched before the body ran');

        assert.strictEqual(await second, 'rejected', 'precondition: the stub device cannot init under node');
        assert.strictEqual(renderer.isDeviceLost(), false, 'precondition: the queued body cleared the latch');

        assert.strictEqual(
            await settleWhenReady(renderer),
            'pending',
            'whenReady() still rejects for a loss the init that owns the generation has already cleared',
        );
    });

    it('still resolves whenReady() on a healthy ready renderer', async () => {
        // The control for all three above: a rejection keyed on anything wider
        // than an actual loss would fail every ordinary startup wait, and every
        // assertion above would still pass.
        const { renderer } = makeInitialisedRenderer();
        pokeHangingDevice(renderer);
        poke(renderer, 'ready', true);
        assert.strictEqual(renderer.isDeviceLost(), false, 'precondition: no loss');
        assert.strictEqual(await settleWhenReady(renderer), 'resolved', 'an ordinary ready renderer must resolve');
        assert.strictEqual(renderer.isReady(), true, 'and must still report itself ready');
    });
});
