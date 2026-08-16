/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGPU device initialization
 */

/**
 * Vendor/architecture identity of the GPU adapter, copied out of
 * `GPUAdapterInfo` during `init()` (issue #2624 device-loss telemetry).
 * Plain copied strings, never the live `GPUAdapterInfo` object, so reading
 * the snapshot after a device loss (or during teardown) touches no GPU state.
 * Either field is absent when the runtime did not report it as a string.
 */
export interface AdapterInfoSnapshot {
  /** `GPUAdapterInfo.vendor`, e.g. "apple", "nvidia", "intel". */
  vendor?: string;
  /** `GPUAdapterInfo.architecture`, e.g. "common-3", "gen-12lp". */
  architecture?: string;
}

export class WebGPUDevice {
  private adapter: GPUAdapter | null = null;
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private format: GPUTextureFormat = 'bgra8unorm';
  private canvas: HTMLCanvasElement | null = null;
  private lastWidth: number = 0;
  private lastHeight: number = 0;
  private contextConfigured: boolean = false;
  private frameCount: number = 0;
  /** Async GPU validation errors (not caught by try-catch) */
  _uncapturedErrorCount: number = 0;
  _lastUncapturedError: string = '';

  /**
   * Notified when the GPU device is lost for a reason OTHER than intentional
   * teardown (`reason === 'destroyed'`) — e.g. a driver reset from the OS GPU
   * watchdog (Windows TDR) or VRAM exhaustion on a weak/integrated GPU. Once a
   * device is lost every GPU resource created from it is dead, so the renderer
   * cannot present again until it is fully re-initialised. Consumers subscribe
   * (see `Renderer.onDeviceLost`) to react — e.g. reload the model — instead of
   * leaving a permanently blank canvas.
   */
  private deviceLostHandler: ((info: { message: string; reason: string }) => void) | null = null;
  /** Guards against firing the handler more than once for a single device. */
  private deviceLostFired: boolean = false;
  /** See `getAdapterInfo()`. Null until `init()` succeeds in reading it. */
  private adapterInfoSnapshot: AdapterInfoSnapshot | null = null;

  /**
   * Initialize WebGPU device and canvas context
   */
  async init(canvas: HTMLCanvasElement): Promise<void> {
    // Each init() begins a fresh GPUDevice lifetime. Clear the once-per-device
    // guard so a destroy()+init() re-entry can still report a later loss (the
    // previous device's `lost` promise already resolved and set this true).
    this.deviceLostFired = false;

    if (!navigator.gpu) {
      throw new Error('WebGPU not available');
    }

    this.adapter = await navigator.gpu.requestAdapter();
    if (!this.adapter) {
      throw new Error('Failed to get GPU adapter');
    }

    // Snapshot the adapter's identity for device-loss telemetry (issue #2624).
    // `adapter.info` shipped in Chrome/Edge 128 and Safari 26, so the whole
    // read is defensive: a runtime without it (or with a throwing getter)
    // leaves the snapshot null rather than failing init. The strings are
    // COPIED - retaining the live GPUAdapterInfo would pin browser-internal
    // state to this instance for no benefit. `info.description`
    // (fingerprint-adjacent free text, usually empty) and `info.device`
    // (blank in default Chrome) are deliberately not captured.
    this.adapterInfoSnapshot = null;
    try {
      const info = this.adapter.info;
      if (info) {
        const snapshot: AdapterInfoSnapshot = {};
        if (typeof info.vendor === 'string') snapshot.vendor = info.vendor;
        if (typeof info.architecture === 'string') snapshot.architecture = info.architecture;
        this.adapterInfoSnapshot = snapshot;
      }
    } catch (e) {
      // Contained, not swallowed: adapter identity is telemetry enrichment,
      // and a throwing `info` getter must not break device init - but a THROW
      // here is a runtime/compat defect worth a trace, or a null snapshot
      // (also what a browser that merely lacks `adapter.info` reports) would
      // hide it. The loss report simply goes out without the identity.
      console.warn('[WebGPU] adapter.info read threw; loss telemetry will omit adapter identity:', e);
    }

    // Request the adapter's maximum buffer limits. The WebGPU default maxBufferSize
    // is 256 MiB, but a single large mesh (e.g. a multi-GB IFC that meshes to one
    // dense geometry) can need a vertex or index buffer well beyond that — its upload
    // then fails with "Buffer size … exceeds the max buffer size limit", the buffer is
    // invalid, and nothing renders. Adapters commonly advertise up to 2 GiB, so raise
    // the device limits to whatever this adapter supports. Guarded so a runtime that
    // doesn't expose `adapter.limits` (or rejects the required limits) still gets a
    // device with the defaults.
    const limits = this.adapter.limits;
    const requiredLimits: Record<string, number> = {};
    if (limits?.maxBufferSize) {
      requiredLimits.maxBufferSize = limits.maxBufferSize;
    }
    if (limits?.maxStorageBufferBindingSize) {
      requiredLimits.maxStorageBufferBindingSize = limits.maxStorageBufferBindingSize;
    }
    try {
      this.device = await this.adapter.requestDevice({ requiredLimits });
    } catch {
      // Some drivers reject requiredLimits they nominally advertise — fall back to a
      // default device rather than failing to initialise the renderer entirely.
      this.device = await this.adapter.requestDevice();
    }
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.canvas = canvas;

    this.context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!this.context) {
      throw new Error('Failed to get WebGPU context');
    }

    // Capture async GPU errors (validation errors from submit() are async)
    this.device.onuncapturederror = (event) => {
      const msg = event.error?.message ?? String(event);
      console.error('[WebGPU] Uncaptured error:', msg);
      this._lastUncapturedError = msg;
      this._uncapturedErrorCount++;
    };

    // Handle device lost - mark context as needing reconfiguration
    // Use type assertion as 'lost'/'reason' may not be in all WebGPU type definitions
    const deviceWithLost = this.device as GPUDevice & {
      lost?: Promise<{ message: string; reason?: string }>;
    };
    if (deviceWithLost.lost) {
      deviceWithLost.lost.then((info) => {
        const reason = info.reason ?? 'unknown';
        console.warn('[WebGPU] Device lost:', info.message, `(reason: ${reason})`);
        this.contextConfigured = false;
        // `reason === 'destroyed'` is an intentional teardown (a `device.destroy()`
        // call or the page dropping the device) — not a fault, so don't wake the
        // recovery path. Any other reason is a real loss the consumer must react to.
        if (reason !== 'destroyed' && !this.deviceLostFired) {
          this.deviceLostFired = true;
          this.deviceLostHandler?.({ message: info.message, reason });
        }
      });
    }

    this.configureContext();
  }

  /**
   * Configure/reconfigure the canvas context
   * Must be called after canvas resize or when context becomes invalid
   */
  configureContext(): void {
    if (!this.context || !this.device || !this.canvas) return;

    this.lastWidth = this.canvas.width;
    this.lastHeight = this.canvas.height;

    try {
    this.context.configure({
      device: this.device,
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
        alphaMode: 'premultiplied',
    });
      this.contextConfigured = true;
    } catch (e) {
      console.warn('[WebGPU] Failed to configure context:', e);
      this.contextConfigured = false;
    }
  }

  /**
   * Check if context needs reconfiguration (canvas resized or context invalid)
   */
  needsReconfigure(): boolean {
    if (!this.canvas) return false;
    if (!this.contextConfigured) return true;
    return this.canvas.width !== this.lastWidth || this.canvas.height !== this.lastHeight;
  }

  /**
   * Mark context as needing reconfiguration (call after WebGPU errors)
   */
  invalidateContext(): void {
    this.contextConfigured = false;
  }

  /**
   * Ensure context is valid before rendering
   * Returns true if context is ready, false if we need to skip this frame
   */
  ensureContext(): boolean {
    if (!this.context || !this.device || !this.canvas) return false;
    
    // Always reconfigure if needed
    if (this.needsReconfigure()) {
      this.configureContext();
    }
    
    return this.contextConfigured;
  }

  /**
   * Get current frame's texture safely
   * Returns null if texture is not available (context needs reconfiguration)
   */
  getCurrentTexture(): GPUTexture | null {
    if (!this.context || !this.contextConfigured) {
      return null;
    }
    
    try {
      const texture = this.context.getCurrentTexture();
      this.frameCount++;
      return texture;
    } catch (e) {
      // Context became invalid, mark for reconfiguration
      this.contextConfigured = false;
      return null;
    }
  }

  getDevice(): GPUDevice {
    if (!this.device) {
      throw new Error('Device not initialized');
    }
    return this.device;
  }

  /**
   * Register the callback fired when this device is lost for a non-intentional
   * reason (see `deviceLostHandler`). Only one handler is kept; the renderer
   * owns it and fans out to its own subscribers. Set before `init()` so a loss
   * during the very first frames is not missed.
   */
  onDeviceLost(handler: (info: { message: string; reason: string }) => void): void {
    this.deviceLostHandler = handler;
  }

  /**
   * Max 2D texture dimension reported by the GPU adapter. WebGPU's spec floor is 8192;
   * iGPUs and most desktop GPUs report 8192 or 16384. Render targets / depth textures
   * must not exceed this in either axis or the device fails validation.
   */
  getMaxTextureDimension(): number {
    return this.device?.limits?.maxTextureDimension2D ?? 8192;
  }

  /**
   * Vendor/architecture snapshot copied from `GPUAdapterInfo` during `init()`,
   * or null when the runtime does not expose adapter info (pre-Chrome-128
   * browsers, or a throwing getter). Deliberately NOT cleared by `destroy()`:
   * a device-loss report can race teardown, and two retained strings leak
   * nothing.
   */
  getAdapterInfo(): AdapterInfoSnapshot | null {
    return this.adapterInfoSnapshot;
  }

  getContext(): GPUCanvasContext {
    if (!this.context) {
      throw new Error('Context not initialized');
    }
    return this.context;
  }

  getFormat(): GPUTextureFormat {
    return this.format;
  }

  isInitialized(): boolean {
    return this.device !== null && this.context !== null;
  }

  /**
   * Intentionally tear down the GPU device, freeing the device, its queue, and
   * the canvas-context configuration. An app that recreates a renderer per model
   * otherwise leaks one live GPUDevice (and its VRAM) per reload. The device's
   * `lost` promise resolves with reason `'destroyed'`, which the loss handler
   * above deliberately ignores (intentional teardown, not a fault). After this
   * `isInitialized()` reports false, so the renderer's per-frame guard skips
   * rendering until a fresh `init()`. Idempotent — safe to call more than once.
   */
  destroy(): void {
    if (this.device) {
      try {
        this.device.destroy();
      } catch (e) {
        // A backend can throw if the device is already lost — the goal (freeing
        // the device) is met either way, so swallow it rather than break teardown.
        console.warn('[WebGPU] device.destroy() threw during teardown:', e);
      }
    }
    // Drop our references so nothing re-binds a dead device. The canvas context
    // stays on the element; a later init() reconfigures it against a new device.
    this.device = null;
    this.context = null;
    this.adapter = null;
    this.contextConfigured = false;
  }
}
