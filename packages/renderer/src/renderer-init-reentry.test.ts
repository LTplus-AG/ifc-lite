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
