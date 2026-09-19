/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { Renderer } from './index.js';
import { runGuardedGpuUpload, isMappedCreateBufferOverflow } from './gpu-upload-guard.js';
import type { MeshData } from '@ifc-lite/geometry';

// Issue #4885: every GPU upload path outside `render()`'s own containment —
// `addMeshes` / `loadGeometry` (both wrap `Scene.appendToBatches`), `addMesh`,
// `ensureMeshResources`, `createMeshFromData` — must gate on device loss
// through `runGuardedGpuUpload`, returning a typed no-op instead of throwing
// into whatever called them. This file pins that, plus the RangeError probe
// that tells a lost-device symptom apart from real host memory pressure.

(globalThis as Record<string, unknown>).GPUBufferUsage = {
    MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
    VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};
(globalThis as Record<string, unknown>).GPUTextureUsage = {
    COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
};
(globalThis as Record<string, unknown>).GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

/** Verbatim Chromium wording from the issue's production report. */
const MAPPED_CREATE_BUFFER_MESSAGE =
    "Failed to execute 'createBuffer' on 'GPUDevice': createBuffer failed, " +
    'size (672) is too large for the implementation when mappedAtCreation == true';

function poke(renderer: Renderer, field: string, value: unknown): void {
    (renderer as unknown as Record<string, unknown>)[field] = value;
}
function read(renderer: Renderer, field: string): unknown {
    return (renderer as unknown as Record<string, unknown>)[field];
}

function makeCanvas(): HTMLCanvasElement {
    return {
        width: 256,
        height: 256,
        getBoundingClientRect: () => ({ width: 256, height: 256 }),
    } as unknown as HTMLCanvasElement;
}

function triangle(expressId: number): MeshData {
    return {
        expressId,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        color: [0.5, 0.5, 0.5, 1] as [number, number, number, number],
    } as MeshData;
}

/**
 * A renderer wired to a working fake GPU device — real enough for
 * `Scene.appendToBatches` and the single-mesh upload paths to actually run —
 * with `createBuffer` call counting and a direct trigger for the renderer's
 * own `handleDeviceLost()`, the same private-method-call shape
 * `renderer-init-reentry.test.ts` uses for `markReady`.
 *
 * `init()` is never called (as in `renderer-render-paths.test.ts`'s
 * `makeHarness`), so nothing subscribes `handleDeviceLost` to a `device.lost`
 * promise automatically — `lose()` invokes it directly, standing in for
 * either loss channel (the async promise, or Safari's synchronous throw).
 */
function makeUploadableRenderer(): { renderer: Renderer; createBufferCalls: () => number; lose: () => void } {
    let createBufferCalls = 0;
    const queue = { writeBuffer() { /* no-op */ } };
    // `mappedAtCreation` buffers need a real backing store — see
    // `scene-batch-upload.ts`'s `getMappedRange().set(...)` calls.
    const makeBuffer = (desc: { size: number }) => {
        const ab = new ArrayBuffer(desc.size);
        return { getMappedRange: () => ab, unmap: () => undefined, destroy: () => undefined };
    };
    const fakeDevice = new Proxy({} as Record<string | symbol, unknown>, {
        get(_t, prop) {
            switch (prop) {
                case 'limits': return { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024 };
                case 'queue': return queue;
                case 'createBuffer': return (desc: { size: number }) => { createBufferCalls++; return makeBuffer(desc); };
                case 'createBindGroup': return () => ({});
                case 'createCommandEncoder': return () => ({ beginRenderPass: () => ({}), finish: () => ({}) });
                case 'createShaderModule': return () => ({});
                case 'createRenderPipeline': return () => ({ getBindGroupLayout: () => ({}) });
                case 'pushErrorScope': return () => undefined;
                case 'popErrorScope': return () => Promise.resolve(null);
                default: return () => undefined;
            }
        },
    });

    const renderer = new Renderer(makeCanvas());
    poke(renderer, 'device', {
        isInitialized: () => true,
        getDevice: () => fakeDevice,
        onDeviceLost: () => { /* lose() below calls the handler directly */ },
        init: async () => { throw new Error('no WebGPU in node'); },
        destroy: () => { /* nothing real to release */ },
    });
    poke(renderer, 'pipeline', {
        getUniformBufferSize: () => 240,
        getBindGroupLayout: () => ({}),
    });

    return {
        renderer,
        createBufferCalls: () => createBufferCalls,
        lose: () => {
            const handleDeviceLost = read(renderer, 'handleDeviceLost') as
                (info: { message: string; reason: string }) => void;
            const warn = mock.method(console, 'warn', () => undefined);
            const error = mock.method(console, 'error', () => undefined);
            try {
                handleDeviceLost.call(renderer, { message: 'driver reset', reason: 'unknown' });
            } finally {
                warn.mock.restore();
                error.mock.restore();
            }
        },
    };
}

describe('isMappedCreateBufferOverflow', () => {
    it('matches the mapped-createBuffer RangeError, at production sizes down to a few hundred bytes', () => {
        for (const size of [672, 5544, 15176, 193836]) {
            const message =
                `Failed to execute 'createBuffer' on 'GPUDevice': createBuffer failed, size (${size}) ` +
                'is too large for the implementation when mappedAtCreation == true';
            assert.strictEqual(isMappedCreateBufferOverflow(new RangeError(message)), true);
        }
    });

    it('does not match an unrelated RangeError or a differently-typed throw', () => {
        assert.strictEqual(isMappedCreateBufferOverflow(new RangeError('Array buffer allocation failed')), false);
        assert.strictEqual(isMappedCreateBufferOverflow(new Error(MAPPED_CREATE_BUFFER_MESSAGE)), false);
        assert.strictEqual(isMappedCreateBufferOverflow('a string'), false);
    });
});

describe('runGuardedGpuUpload', () => {
    it('never calls run() when the device is already known lost', () => {
        let ran = false;
        const outcome = runGuardedGpuUpload(() => true, () => { ran = true; });
        assert.deepStrictEqual(outcome, { ok: false, reason: 'device-lost' });
        assert.strictEqual(ran, false);
    });

    it('returns the callback value on success', () => {
        const outcome = runGuardedGpuUpload(() => false, () => 42);
        assert.deepStrictEqual(outcome, { ok: true, value: 42 });
    });

    it('classifies a mapped-createBuffer RangeError as device loss when the loss lands during the call', () => {
        // Models the race the pre-check alone cannot close: `isDeviceLost()`
        // answers false when the call starts, but the loss latches (the
        // async `device.lost` promise resolving, or a synchronous Safari
        // throw) before the catch re-checks it.
        let lost = false;
        const outcome = runGuardedGpuUpload(
            () => lost,
            () => {
                lost = true;
                throw new RangeError(MAPPED_CREATE_BUFFER_MESSAGE);
            },
        );
        assert.strictEqual(outcome.ok, false);
        assert.ok(!outcome.ok && outcome.reason === 'error');
        if (!outcome.ok && outcome.reason === 'error') {
            assert.strictEqual(isMappedCreateBufferOverflow(outcome.error), true);
            assert.strictEqual(outcome.deviceLostAtTime, true);
        }
    });

    it('reports deviceLostAtTime: false for a throw on a device that stayed alive', () => {
        const outcome = runGuardedGpuUpload(() => false, () => { throw new RangeError('Array buffer allocation failed'); });
        assert.strictEqual(outcome.ok, false);
        assert.ok(!outcome.ok && outcome.reason === 'error' && outcome.deviceLostAtTime === false);
    });

    it('calls onLossDetected for a synchronous DOMException (Safari-style loss), not for a plain RangeError', () => {
        // Review (#4885): a call outside render()'s own containment has no
        // other path to `handleDeviceLost` for THIS throw shape — `isDeviceLost`
        // above only re-READS state, it never sets it. Without this callback the
        // renderer would never learn a Safari-style synchronous loss happened.
        const lossCalls: unknown[] = [];
        const domOutcome = runGuardedGpuUpload(
            () => false,
            () => { throw new DOMException('invalid state', 'InvalidStateError'); },
            (error) => lossCalls.push(error),
        );
        assert.strictEqual(domOutcome.ok, false);
        assert.strictEqual(lossCalls.length, 1);
        assert.ok(lossCalls[0] instanceof DOMException);

        lossCalls.length = 0;
        const rangeOutcome = runGuardedGpuUpload(
            () => false,
            () => { throw new RangeError('Array buffer allocation failed'); },
            (error) => lossCalls.push(error),
        );
        assert.strictEqual(rangeOutcome.ok, false);
        assert.strictEqual(lossCalls.length, 0, 'a plain RangeError on a healthy device is not a loss signal');
    });
});

describe('Renderer upload paths after a simulated device loss (#4885)', () => {
    it('addMeshes returns the typed no-op and never touches the device', () => {
        const h = makeUploadableRenderer();
        h.lose();
        const before = h.createBufferCalls();
        const outcome = h.renderer.addMeshes([triangle(1)]);
        assert.deepStrictEqual(outcome, { ok: false, reason: 'device-lost' });
        assert.strictEqual(h.createBufferCalls(), before, 'no createBuffer call reached a lost device');
    });

    it('addMeshes succeeds before loss (control)', () => {
        const h = makeUploadableRenderer();
        const outcome = h.renderer.addMeshes([triangle(1)]);
        assert.strictEqual(outcome.ok, true);
        assert.ok(h.createBufferCalls() > 0, 'a healthy device does receive the upload');
    });

    it('loadGeometry returns the typed no-op and never touches the device', () => {
        const h = makeUploadableRenderer();
        h.lose();
        const before = h.createBufferCalls();
        const outcome = h.renderer.loadGeometry([triangle(1)]);
        assert.deepStrictEqual(outcome, { ok: false, reason: 'device-lost' });
        assert.strictEqual(h.createBufferCalls(), before);
    });

    it('ensureMeshResources returns the typed no-op and never touches the device', () => {
        const h = makeUploadableRenderer();
        h.renderer.addMeshes([triangle(1)]); // populate the scene via the batched path
        h.lose();
        const before = h.createBufferCalls();
        const outcome = h.renderer.ensureMeshResources();
        assert.deepStrictEqual(outcome, { ok: false, reason: 'device-lost' });
        assert.strictEqual(h.createBufferCalls(), before);
    });

    it('addMesh(single mesh) skips buffer creation after loss but still adds the mesh to the scene', () => {
        // Unlike addMeshes/loadGeometry (pure uploads, nothing else to do on
        // loss), addMesh's OTHER job — registering the mesh in the scene for
        // picking/bbox — has nothing to do with the GPU and must still
        // happen, so the outcome here is a successful no-buffer add, not a
        // device-lost outcome.
        const h = makeUploadableRenderer();
        h.lose();
        const before = h.createBufferCalls();
        const mesh = {
            expressId: 1,
            vertexBuffer: {} as GPUBuffer,
            indexBuffer: {} as GPUBuffer,
            indexCount: 3,
            transform: { m: new Float32Array(16) },
            color: [0.5, 0.5, 0.5, 1],
        } as never;
        const outcome = h.renderer.addMesh(mesh);
        assert.deepStrictEqual(outcome, { ok: true, value: undefined });
        assert.strictEqual(h.createBufferCalls(), before, 'no createBuffer call reached the lost device');
        assert.strictEqual((mesh as { uniformBuffer?: unknown }).uniformBuffer, undefined);
    });

    it('createMeshFromData returns the typed no-op and never touches the device', () => {
        const h = makeUploadableRenderer();
        h.lose();
        const before = h.createBufferCalls();
        const outcome = h.renderer.createMeshFromData(triangle(1));
        assert.deepStrictEqual(outcome, { ok: false, reason: 'device-lost' });
        assert.strictEqual(h.createBufferCalls(), before);
    });
});

describe('a synchronous Safari-style loss during an upload latches isDeviceLost() (review, #4885)', () => {
    /** Silence the console output `handleDeviceLost` emits. */
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
     * A renderer whose device throws a `DOMException` from `createBuffer` on
     * the FIRST call — the Chromium fake in `makeUploadableRenderer` above
     * only ever succeeds, so this is a separate, minimal device wired the
     * same way, isolated to the single-mesh `addMesh` path (its `createBuffer`
     * call is direct, not behind `Scene.appendToBatches`'s batching).
     */
    function makeRendererWithThrowingCreateBuffer(): Renderer {
        const fakeDevice = new Proxy({} as Record<string | symbol, unknown>, {
            get(_t, prop) {
                if (prop === 'createBuffer') {
                    return () => { throw new DOMException('invalid state', 'InvalidStateError'); };
                }
                return () => undefined;
            },
        });
        const renderer = new Renderer(makeCanvas());
        poke(renderer, 'device', {
            isInitialized: () => true,
            getDevice: () => fakeDevice,
            onDeviceLost: () => undefined,
            init: async () => { throw new Error('no WebGPU in node'); },
            destroy: () => undefined,
        });
        poke(renderer, 'pipeline', { getUniformBufferSize: () => 240, getBindGroupLayout: () => ({}) });
        return renderer;
    }

    it('addMesh latches isDeviceLost() on a synchronous DOMException instead of leaving it false forever', () => {
        const renderer = makeRendererWithThrowingCreateBuffer();
        assert.strictEqual(renderer.isDeviceLost(), false, 'precondition: not lost yet');

        const mesh = {
            expressId: 1,
            vertexBuffer: {} as GPUBuffer,
            indexBuffer: {} as GPUBuffer,
            indexCount: 3,
            transform: { m: new Float32Array(16) },
            color: [0.5, 0.5, 0.5, 1],
        };
        const outcome = withQuietConsole(() => renderer.addMesh(mesh as never));

        assert.strictEqual(outcome.ok, false);
        assert.ok(!outcome.ok && outcome.reason === 'error' && outcome.deviceLostAtTime === true);
        assert.strictEqual(
            renderer.isDeviceLost(),
            true,
            'render() latches a synchronous DOMException — an upload call outside it must too, or nothing ever learns the device died',
        );

        // ...and the SECOND call skips buffer creation cleanly (addMesh's own
        // lost-device branch, pinned separately above) instead of repeating
        // the throw — `isDeviceLost()` being true is what routes it there.
        const second = withQuietConsole(() => renderer.addMesh({ ...mesh, expressId: 2 } as never));
        assert.deepStrictEqual(second, { ok: true, value: undefined });
    });
});
