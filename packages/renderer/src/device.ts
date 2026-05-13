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
   * Initialize WebGPU device and canvas context
   */
  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (!navigator.gpu) {
      throw new Error('WebGPU not available');
    }

    this.adapter = await navigator.gpu.requestAdapter();
    if (!this.adapter) {
      throw new Error('Failed to get GPU adapter');
    }

    this.device = await this.adapter.requestDevice();
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.canvas = canvas;

    this.context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!this.context) {
      throw new Error('Failed to get WebGPU context');
    }

    // Capture async GPU errors (validation errors from submit() are async)
    this.device.onuncapturederror = (event) => {
      const msg = (event as any).error?.message ?? String(event);
      console.error('[WebGPU] Uncaptured error:', msg);
      this._lastUncapturedError = msg;
      this._uncapturedErrorCount++;
    };

    // Handle device lost - mark context as needing reconfiguration
    // Use type assertion as 'lost' may not be in all WebGPU type definitions
    const deviceWithLost = this.device as GPUDevice & { lost?: Promise<{ message: string }> };
    if (deviceWithLost.lost) {
      deviceWithLost.lost.then((info) => {
        console.warn('[WebGPU] Device lost:', info.message);
        this.contextConfigured = false;
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
