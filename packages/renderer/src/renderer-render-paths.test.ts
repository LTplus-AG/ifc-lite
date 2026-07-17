/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { Renderer } from './index.js';
import type { MeshData, RenderOptions, BatchedMesh } from './types.js';

/**
 * Drives the REAL render() loop against a stub GPU so the frame-lifecycle
 * fixes are exercised end to end without a browser: error-scope push/pop
 * balance on every exit path, destroy() idempotency, content-based
 * visibility epochs reaching the batched draw path, partial-cache
 * drop/rebuild on hide/isolate toggling, and hydrated-mesh disposal across
 * selections and federated models. The stub records buffer creates/destroys
 * and draw calls; everything else (Scene, Camera, batching, caches) is real.
 */

// WebGPU enum globals used by Scene buffer creation (not defined in node).
(globalThis as Record<string, unknown>).GPUBufferUsage = {
    MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
    VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};
(globalThis as Record<string, unknown>).GPUTextureUsage = {
    COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
};

interface FakeBuffer {
    size: number;
    destroyed: number;
    getMappedRange(): ArrayBuffer;
    unmap(): void;
    destroy(): void;
}

interface Harness {
    renderer: Renderer;
    stats: {
        push: number;
        pop: number;
        /** vertex buffer bound at slot 0 when each drawIndexed fired */
        draws: unknown[];
        createdBuffers: FakeBuffer[];
    };
    knobs: {
        /** 'texture' = getCurrentTexture succeeds; 'null' = returns null */
        textureMode: 'texture' | 'null';
        /** make command encoding throw (mid-encode device fault) */
        encodeThrows: boolean;
        /** make popErrorScope() reject (device lost while scope pending) */
        popRejects: boolean;
    };
    render(options?: RenderOptions): void;
    /** flush the popErrorScope() promise chains */
    settle(): Promise<void>;
}

function makeHarness(): Harness {
    const stats: Harness['stats'] = { push: 0, pop: 0, draws: [], createdBuffers: [] };
    const knobs: Harness['knobs'] = { textureMode: 'texture', encodeThrows: false, popRejects: false };

    const makeBuffer = (desc: { size: number }): FakeBuffer => {
        const buf: FakeBuffer & { _ab: ArrayBuffer } = {
            size: desc.size,
            destroyed: 0,
            _ab: new ArrayBuffer(desc.size),
            getMappedRange() { return this._ab; },
            unmap() { /* no-op */ },
            destroy() { this.destroyed++; },
        };
        stats.createdBuffers.push(buf);
        return buf;
    };

    let boundVertexBuffer: unknown = null;
    const pass = new Proxy({} as Record<string | symbol, unknown>, {
        get(_t, prop) {
            if (prop === 'setVertexBuffer') {
                return (slot: number, buf: unknown) => { if (slot === 0) boundVertexBuffer = buf; };
            }
            if (prop === 'drawIndexed') {
                return () => { stats.draws.push(boundVertexBuffer); };
            }
            return () => undefined;
        },
    });

    const encoder = new Proxy({} as Record<string | symbol, unknown>, {
        get(_t, prop) {
            if (prop === 'beginRenderPass') {
                return () => {
                    if (knobs.encodeThrows) throw new Error('boom mid-encode');
                    return pass;
                };
            }
            if (prop === 'finish') return () => ({});
            return () => undefined;
        },
    });

    const queue = {
        writeBuffer() { /* no-op */ },
        submit() { /* no-op */ },
        onSubmittedWorkDone() { return Promise.resolve(); },
    };
    const fakeGpuDevice = new Proxy({} as Record<string | symbol, unknown>, {
        get(_t, prop) {
            switch (prop) {
                case 'limits': return { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024 };
                case 'queue': return queue;
                case 'pushErrorScope': return () => { stats.push++; };
                case 'popErrorScope': return () => {
                    stats.pop++;
                    return knobs.popRejects
                        ? Promise.reject(new Error('Instance dropped in popErrorScope'))
                        : Promise.resolve(null);
                };
                case 'createCommandEncoder': return () => encoder;
                case 'createBuffer': return (desc: { size: number }) => makeBuffer(desc);
                case 'createBindGroup': return () => ({});
                case 'createTexture': return () => ({ createView: () => ({}), destroy() { /* no-op */ } });
                default: return () => undefined;
            }
        },
    });

    const fakeContext = {
        configure() { /* no-op */ },
        getCurrentTexture() {
            return knobs.textureMode === 'texture' ? { createView: () => ({}) } : null;
        },
    };

    const canvas = {
        width: 256,
        height: 256,
        getBoundingClientRect: () => ({ width: 256, height: 256 }),
    } as unknown as HTMLCanvasElement;

    const renderer = new Renderer(canvas);
    // Wire the stub GPU into the real WebGPUDevice wrapper (init() needs a
    // browser); keep lastWidth/lastHeight in sync so no reconfigure fires.
    const wdev = renderer['device'] as unknown as Record<string, unknown>;
    wdev['device'] = fakeGpuDevice;
    wdev['context'] = fakeContext;
    wdev['canvas'] = canvas;
    wdev['contextConfigured'] = true;
    wdev['lastWidth'] = 256;
    wdev['lastHeight'] = 256;
    // Permissive pipeline stub: draw-state getters return inert objects,
    // sizing predicates return stable values, everything else no-ops.
    (renderer as unknown as Record<string, unknown>)['pipeline'] = new Proxy(
        {} as Record<string | symbol, unknown>,
        {
            get(_t, prop) {
                switch (prop) {
                    case 'needsResize': return () => false;
                    case 'getSampleCount': return () => 1;
                    case 'getMultisampleTextureView': return () => null;
                    case 'getUniformBufferSize': return () => 240;
                    case 'getQuantizedPipelineVariant': return () => null;
                    default: return () => ({});
                }
            },
        },
    );

    return {
        renderer,
        stats,
        knobs,
        render(options: RenderOptions = {}) {
            // Post passes need real GPU textures — keep them off in the stub.
            renderer.render({ visualEnhancement: { enabled: false }, ...options });
        },
        async settle() {
            // Two microtask turns flush the then/catch chains on popErrorScope.
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        },
    };
}

function triangle(expressId: number, color: [number, number, number, number], modelIndex?: number): MeshData {
    return {
        expressId,
        modelIndex,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        color,
    } as MeshData;
}

const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
const RED: [number, number, number, number] = [0.8, 0.1, 0.1, 1];

/** Build two real colour batches: grey {1, 2} and red {3}. */
function seedBatches(h: Harness): { grey: BatchedMesh; red: BatchedMesh } {
    const scene = h.renderer.getScene();
    const device = h.renderer['device'].getDevice();
    const pipeline = h.renderer['pipeline'] as never;
    scene.appendToBatches([triangle(1, GREY), triangle(2, GREY), triangle(3, RED)], device, pipeline, false);
    const batches = scene.getBatchedMeshes();
    assert.strictEqual(batches.length, 2, 'expected one grey and one red batch');
    // Strip bounds so the default camera cannot frustum-cull the fixtures.
    for (const b of batches) b.bounds = undefined;
    const grey = batches.find((b) => b.expressIds.includes(1))!;
    const red = batches.find((b) => b.expressIds.includes(3))!;
    return { grey, red };
}

describe('render() error-scope balance', () => {
    it('pops the scope on a null-current-texture frame', async () => {
        const h = makeHarness();
        h.knobs.textureMode = 'null';
        h.render();
        await h.settle();
        assert.strictEqual(h.stats.push, 1);
        assert.strictEqual(h.stats.pop, 1);
    });

    it('pops the scope when encoding throws mid-frame, and keeps counts balanced across mixed frames', async () => {
        const h = makeHarness();
        h.knobs.encodeThrows = true;
        h.render();
        await h.settle();
        assert.strictEqual(h.stats.push, 1);
        assert.strictEqual(h.stats.pop, 1);
        assert.strictEqual(h.renderer.getDiagnostics().errors, 1);

        // A throwing frame, a null-texture frame, and normal frames — every
        // pushed scope must be popped exactly once, incl. past the capture
        // window (first 5 renders) where neither is called.
        h.knobs.encodeThrows = false;
        h.knobs.textureMode = 'null';
        h.render();
        h.knobs.textureMode = 'texture';
        for (let i = 0; i < 6; i++) h.render();
        await h.settle();
        assert.strictEqual(h.stats.push, h.stats.pop);
        assert.ok(h.stats.push < 8, 'capture window must stop pushing after the first renders');
    });

    it('logs (not swallows) a popErrorScope rejection and invalidates the context', async () => {
        const h = makeHarness();
        h.knobs.popRejects = true;
        const warn = mock.method(console, 'warn', () => undefined);
        try {
            h.render();
            await h.settle();
            const logged = warn.mock.calls.some((c) =>
                String(c.arguments[0]).includes('popErrorScope rejected'));
            assert.ok(logged, 'rejection must be logged, not silently caught');
        } finally {
            warn.mock.restore();
        }
        // The wrapper marks the context for reconfiguration on loss evidence.
        assert.strictEqual(h.renderer['device']['contextConfigured'], false);
    });

    it('logs the rejection from the null-texture bail-out path too', async () => {
        const h = makeHarness();
        h.knobs.popRejects = true;
        h.knobs.textureMode = 'null';
        const warn = mock.method(console, 'warn', () => undefined);
        try {
            h.render();
            await h.settle();
            const logged = warn.mock.calls.some((c) =>
                String(c.arguments[0]).includes('popErrorScope rejected'));
            assert.ok(logged);
        } finally {
            warn.mock.restore();
        }
    });
});

describe('destroy() lifecycle', () => {
    it('is idempotent and render() after destroy() is a silent skip', () => {
        const h = makeHarness();
        seedBatches(h);
        h.render();
        assert.doesNotThrow(() => h.renderer.destroy());
        assert.doesNotThrow(() => h.renderer.destroy());
        const skipsBefore = h.renderer.getDiagnostics().skips;
        assert.doesNotThrow(() => h.render());
        assert.strictEqual(h.renderer.getDiagnostics().skips, skipsBefore + 1);
        assert.strictEqual(h.renderer.getDiagnostics().errors, 0);
    });

    it('destroy() frees batch buffers exactly once', () => {
        const h = makeHarness();
        const { grey, red } = seedBatches(h);
        h.renderer.destroy();
        h.renderer.destroy();
        assert.strictEqual((grey.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
        assert.strictEqual((red.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
    });
});

describe('visibility epoch drives the batched draw path', () => {
    it('sees an IN-PLACE mutation of the hiddenIds Set (regression: reference-compare epoch)', () => {
        const h = makeHarness();
        const { grey, red } = seedBatches(h);

        const hidden = new Set<number>();
        h.render({ hiddenIds: hidden });
        assert.ok(h.stats.draws.includes(grey.vertexBuffer), 'grey batch draws while nothing is hidden');
        assert.ok(h.stats.draws.includes(red.vertexBuffer));

        // Mutate the SAME Set in place: id 1 hides, grey batch {1,2} becomes
        // partially visible and must be replaced by a sub-batch clone.
        hidden.add(1);
        h.stats.draws.length = 0;
        h.render({ hiddenIds: hidden });
        assert.ok(!h.stats.draws.includes(grey.vertexBuffer),
            'partially hidden batch must not draw from its own buffers');
        assert.ok(h.stats.draws.includes(red.vertexBuffer), 'red batch is unaffected');
        const scene = h.renderer.getScene();
        assert.strictEqual(scene['partialBatchCache'].size, 1, 'a partial sub-batch was built');

        // Mutate in place again: id 2 hides too, the grey batch is now fully
        // hidden — the batched path must notice (no grey geometry at all).
        hidden.add(2);
        h.stats.draws.length = 0;
        h.render({ hiddenIds: hidden });
        const greyIshDraws = h.stats.draws.filter((d) => d !== red.vertexBuffer);
        assert.strictEqual(greyIshDraws.length, 0, 'fully hidden batch (and its sub-batch) must not draw');
    });

    it('does NOT rebuild caches for a fresh Set with identical content', () => {
        const h = makeHarness();
        seedBatches(h);
        h.render({ hiddenIds: new Set([1]) });
        const version = h.renderer['_visibilityVersion'];
        const buffersAfterFirst = h.stats.createdBuffers.length;

        h.render({ hiddenIds: new Set([1]) });
        assert.strictEqual(h.renderer['_visibilityVersion'], version, 'same content, new reference: no epoch bump');
        assert.strictEqual(h.stats.createdBuffers.length, buffersAfterFirst, 'no partial sub-batch rebuild');
    });

    it('treats empty hidden set, undefined, and null isolation as the same no-filter state', () => {
        const h = makeHarness();
        seedBatches(h);
        h.render({});
        const version = h.renderer['_visibilityVersion'];
        h.render({ hiddenIds: new Set() });
        h.render({ hiddenIds: undefined, isolatedIds: null });
        h.render({ isolatedIds: undefined });
        assert.strictEqual(h.renderer['_visibilityVersion'], version);
    });

    it('rapid hide -> show-all -> same set -> different set: partial caches drop and rebuild, buffers destroyed exactly once', () => {
        const h = makeHarness();
        seedBatches(h);
        const scene = h.renderer.getScene();

        h.render({ hiddenIds: new Set([1]) });
        assert.strictEqual(scene['partialBatchCache'].size, 1);
        const firstClone = [...scene['partialBatchCache'].values()][0] as BatchedMesh;
        const firstVb = firstClone.vertexBuffer as unknown as FakeBuffer;

        // Show all: the return-to-fully-visible transition must free the clone.
        h.render({});
        assert.strictEqual(scene['partialBatchCache'].size, 0, 'partial caches dropped on show-all');
        assert.strictEqual(firstVb.destroyed, 1);

        // Hide the SAME set again: a fresh clone is built (old one stays freed).
        h.render({ hiddenIds: new Set([1]) });
        assert.strictEqual(scene['partialBatchCache'].size, 1);
        const secondClone = [...scene['partialBatchCache'].values()][0] as BatchedMesh;
        assert.notStrictEqual(secondClone, firstClone, 'dropped clone must not be resurrected');
        assert.strictEqual(firstVb.destroyed, 1, 'no double-destroy of the dropped clone');

        // Different set while filtering holds: in-place invalidation replaces
        // the clone and frees the previous one exactly once.
        h.render({ hiddenIds: new Set([2]) });
        assert.strictEqual((secondClone.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
        assert.strictEqual(scene['partialBatchCache'].size, 1);

        // Back to show-all: everything freed exactly once, nothing twice.
        h.render({});
        assert.strictEqual(scene['partialBatchCache'].size, 0);
        assert.strictEqual(firstVb.destroyed, 1);
        assert.strictEqual((secondClone.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
        for (const buf of h.stats.createdBuffers) {
            assert.ok(buf.destroyed <= 1, 'a VRAM-tracked buffer was destroyed more than once');
        }
    });
});

describe('hydrated selection meshes across renders', () => {
    it('selection thrash: earlier selections are disposed, the current one is kept', () => {
        const h = makeHarness();
        seedBatches(h);
        const scene = h.renderer.getScene();

        const hydratedFor = (id: number) =>
            scene.getMeshes().filter((m) => m.hydrated && m.expressId === id);

        h.render({ selectedId: 1 });
        assert.strictEqual(hydratedFor(1).length, 1, 'selected entity hydrates an individual mesh');
        const mesh1 = hydratedFor(1)[0];

        h.render({ selectedId: 2 });
        assert.strictEqual(hydratedFor(1).length, 0, 'previous selection is disposed');
        assert.strictEqual((mesh1.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
        assert.strictEqual(hydratedFor(2).length, 1);
        const mesh2 = hydratedFor(2)[0];

        h.render({ selectedId: 3 });
        assert.strictEqual((mesh2.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
        assert.strictEqual(hydratedFor(3).length, 1);

        h.render({});
        assert.strictEqual(scene.getMeshes().filter((m) => m.hydrated).length, 0, 'deselect frees everything');
        for (const buf of h.stats.createdBuffers) {
            assert.ok(buf.destroyed <= 1, 'hydrated mesh buffer double-destroyed');
        }
    });

    it('same express id in two federated models: switching models disposes the other model\'s mesh', () => {
        const h = makeHarness();
        seedBatches(h);
        const scene = h.renderer.getScene();
        // Two models share express id 42 (federation reuses local ids).
        scene.addMeshData(triangle(42, GREY, 0));
        scene.addMeshData(triangle(42, RED, 1));

        h.render({ selectedId: 42, selectedModelIndex: 0 });
        const model0 = scene.getMeshes().filter((m) => m.hydrated && m.expressId === 42);
        assert.strictEqual(model0.length, 1);
        assert.strictEqual(model0[0].modelIndex, 0);

        // Same express id, different model — the model-0 mesh must be freed
        // (an id-only snapshot would keep it resident and drawing).
        h.render({ selectedId: 42, selectedModelIndex: 1 });
        const hydrated = scene.getMeshes().filter((m) => m.hydrated && m.expressId === 42);
        assert.strictEqual(hydrated.length, 1, 'exactly one model\'s mesh stays hydrated');
        assert.strictEqual(hydrated[0].modelIndex, 1);
        assert.strictEqual((model0[0].vertexBuffer as unknown as FakeBuffer).destroyed, 1);

        h.render({});
        assert.strictEqual(scene.getMeshes().filter((m) => m.hydrated).length, 0);
    });
});
