/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WebGPU device initialization
 */

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
}
