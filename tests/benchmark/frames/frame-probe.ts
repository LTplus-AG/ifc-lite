/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * In-page frame probe shared by both frame-time rigs (#6960).
 *
 * Installed with `page.addInitScript(installFrameProbe, config)` BEFORE the
 * viewer boots, so it is app-agnostic: no viewer code knows it exists. It
 * wraps `requestAnimationFrame` (every rAF callback of one frame is folded
 * into one record keyed by the frame timestamp) and patches the WebGPU
 * prototypes the renderer calls, so a frame record says how much JS ran in
 * that frame's rAF callbacks and how much GPU work it encoded:
 *
 *   presents   `GPUCanvasContext.getCurrentTexture` calls. The viewer's loop
 *              re-arms rAF every frame but renders only when dirty, so a frame
 *              with `presents > 0` is a RENDERED frame and one without is IDLE.
 *   submits    `GPUQueue.submit` calls; `draws` every draw* on a render pass.
 *   writeBytes `GPUQueue.writeBuffer` payload bytes (uploads, uniforms).
 *
 * GPU work issued OUTSIDE any rAF callback (streaming uploads from a worker
 * message handler) is attributed to the next frame's `outside*` fields.
 *
 * `workDone: true` also measures `GPUQueue.onSubmittedWorkDone()` latency
 * once per frame that submitted: time from the end of that frame's rAF
 * callbacks to the queue reporting the work finished. That is queue latency
 * plus GPU execution, NOT a GPU timestamp; it is meaningful only on a real
 * GPU and the deterministic (SwiftShader) rig leaves it off.
 *
 * Everything below must stay self-contained: Playwright serialises the
 * function source into the page, so it may not reference module scope.
 */

export interface FrameProbeConfig {
  /** Measure `onSubmittedWorkDone` latency per submitting frame (real GPU only). */
  workDone: boolean;
}

/** One rAF frame, as recorded in the page. */
export interface FrameRecord {
  /** rAF timestamp (ms, the page's performance timeline). */
  ts: number;
  /** rAF callbacks run in this frame. */
  callbacks: number;
  /** Wall ms spent inside this frame's rAF callbacks. */
  cbMs: number;
  presents: number;
  submits: number;
  draws: number;
  writeBytes: number;
  /** GPU calls made between the previous frame's callbacks and this frame's. */
  outsideSubmits: number;
  outsideWriteBytes: number;
  /** `onSubmittedWorkDone` latency (ms) when measured and resolved, else null. */
  workDoneMs: number | null;
}

/** What `globalThis.__ifc_lite_frame_probe__` exposes to the harness. */
export interface FrameProbeHandle {
  /** Drain and return every completed frame record since the last take(). */
  take(): FrameRecord[];
  /** Whether the page saw a WebGPU device being requested with 'timestamp-query'. */
  timestampQueryRequested(): boolean;
  /** Start a new foreground admission interval after boot/settling (#6975). */
  beginForegroundGuard(): void;
  foreground(): { visibility: string; focused: boolean; interruptions: number };
}

export const FRAME_PROBE_GLOBAL = '__ifc_lite_frame_probe__';

export function installFrameProbe(config: FrameProbeConfig): void {
  type Fn = (...args: unknown[]) => unknown;
  type Counters = { presents: number; submits: number; draws: number; writeBytes: number };
  const host = globalThis as unknown as Record<string, unknown>;
  if (host.__ifc_lite_frame_probe__) return;

  const done: FrameRecord[] = [];
  let current: FrameRecord | null = null;
  let inCallback = false;
  const outside = { submits: 0, writeBytes: 0 };
  let workDoneQueue: { onSubmittedWorkDone(): Promise<void> } | null = null;
  let timestampQuery = false;
  let foregroundInterruptions = 0;
  let foregroundGuard = false;
  const interrupted = () => { if (foregroundGuard) foregroundInterruptions++; };
  window.addEventListener('blur', interrupted);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') interrupted();
  });

  const bump = (field: keyof Counters, amount: number) => {
    if (inCallback && current) current[field] += amount;
    else if (field === 'submits' || field === 'writeBytes') outside[field] += amount;
  };

  const patch = (proto: Record<string, unknown> | undefined, name: string, before: (self: unknown, args: unknown[]) => void) => {
    const original = proto?.[name];
    if (!proto || typeof original !== 'function') return;
    proto[name] = function patched(this: unknown, ...args: unknown[]) {
      before(this, args);
      return (original as Fn).apply(this, args);
    };
  };
  const proto = (name: string) => (host[name] as { prototype?: Record<string, unknown> } | undefined)?.prototype;

  patch(proto('GPUCanvasContext'), 'getCurrentTexture', () => bump('presents', 1));
  patch(proto('GPUQueue'), 'submit', (self) => {
    bump('submits', 1);
    if (config.workDone) workDoneQueue = self as { onSubmittedWorkDone(): Promise<void> };
  });
  patch(proto('GPUQueue'), 'writeBuffer', (_self, args) => {
    const data = args[2] as { byteLength?: number } | undefined;
    const size = typeof args[4] === 'number' ? args[4] : (data?.byteLength ?? 0);
    bump('writeBytes', size);
  });
  for (const draw of ['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']) {
    patch(proto('GPURenderPassEncoder'), draw, () => bump('draws', 1));
  }
  patch(proto('GPUAdapter'), 'requestDevice', (_self, args) => {
    const descriptor = args[0] as { requiredFeatures?: Iterable<string> } | undefined;
    if (descriptor?.requiredFeatures && [...descriptor.requiredFeatures].includes('timestamp-query')) timestampQuery = true;
  });

  const finish = () => {
    if (current) done.push(current);
    current = null;
  };

  const nativeRaf = globalThis.requestAnimationFrame.bind(globalThis);
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => nativeRaf((ts: number) => {
    if (!current || current.ts !== ts) {
      finish();
      current = {
        ts, callbacks: 0, cbMs: 0, presents: 0, submits: 0, draws: 0, writeBytes: 0,
        outsideSubmits: outside.submits, outsideWriteBytes: outside.writeBytes, workDoneMs: null,
      };
      outside.submits = 0;
      outside.writeBytes = 0;
    }
    const frame = current;
    const submitsBefore = frame.submits;
    const start = performance.now();
    inCallback = true;
    try {
      callback(ts);
    } finally {
      inCallback = false;
      const end = performance.now();
      frame.cbMs += end - start;
      frame.callbacks += 1;
      const queue = workDoneQueue;
      if (config.workDone && queue && frame.submits > submitsBefore && frame.workDoneMs === null) {
        frame.workDoneMs = -1; // pending: one measurement per frame
        queue.onSubmittedWorkDone().then(
          () => { frame.workDoneMs = performance.now() - end; },
          (error: unknown) => { console.warn('[frame-probe] onSubmittedWorkDone rejected:', error); },
        );
      }
    }
  });

  const handle: FrameProbeHandle = {
    take() {
      // The open frame may still receive callbacks; only completed ones drain.
      const out = done.splice(0, done.length);
      for (const frame of out) if (frame.workDoneMs !== null && frame.workDoneMs < 0) frame.workDoneMs = null;
      return out;
    },
    timestampQueryRequested: () => timestampQuery,
    beginForegroundGuard() {
      foregroundInterruptions = document.visibilityState === 'visible' && document.hasFocus() ? 0 : 1;
      foregroundGuard = true;
    },
    foreground: () => ({
      visibility: document.visibilityState, focused: document.hasFocus(), interruptions: foregroundInterruptions,
    }),
  };
  host.__ifc_lite_frame_probe__ = handle;
}

/**
 * The probe as init-script source, for `addInitScript({ content })`. Passing
 * the function itself breaks under tsx (the real-GPU rig): esbuild's
 * keep-names wraps inner functions in a module-scope `__name` helper that
 * does not exist in the page, so the shim below supplies an identity one.
 */
export function frameProbeInitScript(config: FrameProbeConfig): string {
  return `(() => { const __name = (target) => target; (${installFrameProbe.toString()})(${JSON.stringify(config)}); })();`;
}
