/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createNavigationModel } from './model.js';
import type { DriverCamera, SdkConstructor, SdkInstance, SdkLoader, SpaceMouseDriverOptions } from './types.js';

/** Default loader: a dynamic import, so the SDK is only fetched (and its licence only comes into play) on `connect()`. */
const defaultLoader: SdkLoader = async () => {
  const mod = (await import('@3dconnexion/3dconnexionjs')) as unknown as { default: SdkConstructor };
  return mod;
};

/**
 * SpaceMouse input through the 3Dconnexion driver (3DxWare), for one view.
 *
 * Opt-in and silent: nothing from `@3dconnexion/3dconnexionjs` is loaded until {@link connect} is called, and when the
 * driver is not running `connect()` just resolves `false` (see {@link lastError}); it never throws and does not log
 * unless `debug` is set. The driver moves the camera itself: speed, axes and navigation mode come from the user's
 * 3Dconnexion settings, not from this package.
 *
 * ```ts
 * const driver = new SpaceMouseDriver(cameraAdapter, { appName: 'My viewer' });
 * driver.onFit = () => viewer.fit();
 * driver.onStatus = () => updateIndicator(driver.connected);
 * await driver.connect(); // false if the driver is not running
 * ```
 */
export class SpaceMouseDriver {
  /** True while the driver has attached the device to the view. */
  connected = false;
  /** Why the last `connect()` resolved `false`, for a tooltip or a debug log. */
  lastError?: string;
  /** Fires whenever `connected` changes, including a late connection after `connect()` already gave up. */
  onStatus?: () => void;
  /** The device's Fit key was pressed. */
  onFit?: () => void;

  private lib?: SdkInstance;
  private starting?: Promise<void>;
  private pointer: [number, number] = [0, 0];
  private detach: Array<() => void> = [];
  private waiters = new Set<(ok: boolean) => void>();

  constructor(
    private readonly cam: DriverCamera,
    private readonly opts: SpaceMouseDriverOptions,
  ) {}

  /**
   * Connects to the driver's local web service and resolves `true` once the device is attached to the view, `false`
   * when that did not happen within `timeoutMs` (driver not running, too old, or the SDK could not be loaded).
   * A driver that starts later is still picked up: `onStatus` fires when it does. Safe to call more than once.
   * Needs no user gesture.
   */
  async connect(timeoutMs = 3000): Promise<boolean> {
    if (this.connected) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(settle);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        this.lastError ??= '3Dconnexion driver not reachable (is 3DxWare 10 running?)';
        settle(false);
      }, timeoutMs);
      this.waiters.add(settle);
      this.start().catch((e: unknown) => {
        this.lastError = e instanceof Error ? e.message : String(e);
        settle(false);
      });
    });
  }

  /** Detaches from the driver and removes the listeners this instance added to the view. `connect()` may be called again. */
  disconnect(): void {
    try {
      this.lib?.delete3dmouse();
      this.lib?.session?.close();
    } catch (e) {
      // The connection may already be gone; nothing to recover, but never hide it (no silent catch).
      console.warn('[spacemouse-driver] disconnect:', e);
    }
    this.detach.splice(0).forEach((f) => f());
    this.lib = undefined;
    this.starting = undefined;
    const was = this.connected;
    this.connected = false;
    this.resolveWaiters(false);
    if (was) this.onStatus?.();
  }

  private start(): Promise<void> {
    this.starting ??= this.doStart().catch((e: unknown) => {
      this.starting = undefined; // allow a retry
      throw e;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.lastError = undefined;
    // The SDK reads this flag when its client object is constructed.
    (globalThis as Record<string, unknown>)._3DCONNEXION_DEBUG = !!this.opts.debug;
    const { default: Sdk } = await (this.opts.loadSdk ?? defaultLoader)();

    const canvas = this.cam.canvas;
    if (!(canvas.tabIndex >= 0)) canvas.tabIndex = 0; // the library needs a focusable view
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      this.pointer = [((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2];
    };
    const onDown = () => canvas.focus({ preventScroll: true });
    canvas.addEventListener('pointermove', onMove as EventListener);
    canvas.addEventListener('pointerdown', onDown);
    this.detach.push(
      () => canvas.removeEventListener('pointermove', onMove as EventListener),
      () => canvas.removeEventListener('pointerdown', onDown),
    );

    const model = createNavigationModel(this.cam, { onFit: () => this.onFit?.(), pointer: () => this.pointer }) as Record<string, unknown>;
    model.onConnect = () => this.lib?.create3dmouse(canvas, this.opts.appName);
    model.on3dmouseCreated = () => {
      this.connected = true;
      this.lastError = undefined;
      this.resolveWaiters(true);
      this.onStatus?.();
    };
    model.onDisconnect = (reason: unknown) => {
      const was = this.connected;
      this.connected = false;
      this.lastError = `3Dconnexion driver disconnected (${String(reason ?? '')})`;
      this.resolveWaiters(false);
      if (was) this.onStatus?.();
    };

    this.lib = new Sdk(model);
    this.lib.connect();
  }

  private resolveWaiters(ok: boolean): void {
    for (const w of this.waiters) w(ok); // each waiter deletes only itself, which Set iteration tolerates
  }
}
