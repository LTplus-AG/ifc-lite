/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The ONE guard every GPU upload path outside `render()`'s own containment
 * routes through (issue #4885).
 *
 * `render()` and `renderFrame()` already survive a lost or dying device: a
 * pre-check skips the frame, and `containFrameThrow` catches whatever a
 * mid-frame call throws. Every upload call site that runs OUTSIDE that loop —
 * `addMeshes`, `loadGeometry`, `addMesh`, `ensureMeshResources`,
 * `createMeshFromData`, and the viewer's `setSpaceOverlayMeshes` — has none of
 * that. Before this module, a `device.createBuffer()` on a lost-but-not-yet-
 * `isInitialized()==false` device (see `getGPUDevice()`'s doc: a loss never
 * calls `destroy()`, so the zombie device stays "initialized") threw straight
 * into whatever called it: a React event handler, a store action, a streaming
 * loop. That is how 23 `out_of_memory` events landed for one Edge user in two
 * days — every one of them fallout from a device that had already died.
 */

/** The outcome of one guarded upload call. */
export type GpuUploadOutcome<T> =
    | { ok: true; value: T }
    /** The device was already known lost; `run()` was never called. */
    | { ok: false; reason: 'device-lost' }
    /**
     * `run()` threw. `deviceLostAtTime` is `isDeviceLost()` re-checked
     * AFTER the throw — the loss can latch (the async `device.lost`
     * promise resolving, or a synchronous Safari throw) in the window
     * between this call's own pre-check and the failing GPU call, so a
     * caller that only trusted the pre-check would misreport that race as
     * host memory pressure.
     */
    | { ok: false; reason: 'error'; error: unknown; deviceLostAtTime: boolean };

/**
 * Chromium's wording for a `createBuffer({ mappedAtCreation: true })` the
 * host could not back:
 *
 *   RangeError: Failed to execute 'createBuffer' on 'GPUDevice': createBuffer
 *   failed, size (672) is too large for the implementation when
 *   mappedAtCreation == true
 *
 * — at sizes (672 B, 5.5 KB, 15 KB) nowhere near any real device limit. This
 * is the same string `packages/renderer/src/index.ts`'s `isDeviceLossThrow`
 * deliberately does NOT latch on inside a frame (see that function's doc: a
 * RangeError there is genuine, frame-scoped memory pressure on a device that
 * IS still alive). This matcher answers a different question for a DIFFERENT
 * caller — one that sits outside the frame's own containment and wants to
 * know whether a RangeError it just caught is fallout from a loss that has
 * already happened, not a fresh probe of a healthy device.
 */
export function isMappedCreateBufferOverflow(error: unknown): boolean {
    return error instanceof RangeError
        && /createbuffer failed.*mappedatcreation/i.test(error.message);
}

/**
 * Run one GPU upload, gated on device loss.
 *
 * Pre-checks `isDeviceLost()` so a call site never even reaches a zombie
 * device (the common case in production: the loss already latched, and
 * something kept uploading anyway). Post-checks it in the catch so the
 * narrower race above — the loss landing mid-call — still reports correctly.
 * Never throws: the failure comes back as data, for the caller to log,
 * report to telemetry, or ignore, but never to let escape into a React tree
 * or a streaming loop that has no idea a GPU call could fail this way.
 */
export function runGuardedGpuUpload<T>(
    isDeviceLost: () => boolean,
    run: () => T,
): GpuUploadOutcome<T> {
    if (isDeviceLost()) {
        return { ok: false, reason: 'device-lost' };
    }
    try {
        return { ok: true, value: run() };
    } catch (error) {
        return { ok: false, reason: 'error', error, deviceLostAtTime: isDeviceLost() };
    }
}
