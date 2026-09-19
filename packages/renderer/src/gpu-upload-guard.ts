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

/**
 * Is this throw the GPU device telling us it is gone?
 *
 * The discriminator is the exception TYPE, not its message, because WebGPU
 * draws exactly that line:
 *  - a call on a dead / invalid-state device throws a `DOMException`
 *    (`InvalidStateError` in Safari 26.5 — the whole of issue #2229);
 *  - a buffer allocation the host cannot back throws a plain `RangeError`
 *    ("createBuffer failed, size (…) is too large … when mappedAtCreation ==
 *    true"), which `isMappedCreateBufferOverflow` below documents happening
 *    on a HEALTHY device under memory pressure.
 *
 * Treating the second as a device loss is a false positive that costs the
 * whole session — see `runGuardedGpuUpload`'s doc for how a caught RangeError
 * is instead checked against `isDeviceLost()`, not this classifier, to tell
 * loss fallout from real memory pressure.
 *
 * Shared by `index.ts`'s frame-level `containFrameThrow` (the ONE throw class
 * that latches mid-frame) and this module's `runGuardedGpuUpload` (the same
 * throw class latching from a call OUTSIDE the frame, #4885) — a single
 * classifier, so the two paths cannot drift on what counts as a loss signal.
 *
 * `typeof` guarded because non-DOM hosts (Node before 17, some workers) have
 * no `DOMException` global; there, no throw can be a WebGPU device signal.
 */
export function isDeviceLossThrow(error: unknown): boolean {
    return typeof DOMException !== 'undefined' && error instanceof DOMException;
}

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
 *
 * `onLossDetected` closes the gap `render()`'s own containment does not cover
 * here: Safari's SYNCHRONOUS `DOMException` (issue #2229) reaches this catch
 * without ever having gone through `handleDeviceLost` — nothing upstream of
 * `run()` calls it, unlike the async `device.lost` promise, which the
 * `WebGPUDevice` wrapper already forwards on its own. Without this callback
 * `isDeviceLost()` would answer `false` forever after such a throw and every
 * later call on this path would keep trying the same dead device. Called
 * BEFORE the post-check below, so `deviceLostAtTime` reflects it.
 */
export function runGuardedGpuUpload<T>(
    isDeviceLost: () => boolean,
    run: () => T,
    onLossDetected?: (error: unknown) => void,
): GpuUploadOutcome<T> {
    if (isDeviceLost()) {
        return { ok: false, reason: 'device-lost' };
    }
    try {
        return { ok: true, value: run() };
    } catch (error) {
        if (isDeviceLossThrow(error)) onLossDetected?.(error);
        return { ok: false, reason: 'error', error, deviceLostAtTime: isDeviceLost() };
    }
}
