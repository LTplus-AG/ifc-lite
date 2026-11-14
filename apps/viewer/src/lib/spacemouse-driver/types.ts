/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { V3 } from './math.js';

/**
 * What the driver needs from the host viewer. Implement it as a thin adapter over your camera; nothing else in this
 * package touches viewer internals. World space is the renderer's frame: Y up, the camera looks down -Z, units in
 * metres (the driver is told 1 unit = 1 m).
 */
export interface DriverCamera {
  /** The view element. It is made focusable and focused on pointer-down: the driver moves the focused view. */
  canvas: HTMLElement;
  /** Current camera pose. `target` is the point the camera orbits / looks at. */
  getPose(): { pos: V3; target: V3; up: V3 };
  /**
   * Replace the camera pose. Called every frame while the device moves: stop inertia, set position / target / up
   * together, and keep the horizon level if that is how the mouse orbit behaves.
   */
  setPose(pos: V3, target: V3, up: V3): void;
  /** Vertical field of view, radians. */
  getFov(): number;
  setFov(rad: number): void;
  /** Canvas width / height. */
  getAspect(): number;
  /** Bounds of what is shown, renderer units; `null` when nothing is loaded. */
  getBounds(): { min: V3; max: V3 } | null;
  /** Ask the viewer to draw a frame. */
  requestRender(): void;
}

/** The part of the SDK's `_3Dconnexion` class this package uses. */
export interface SdkInstance {
  connect(): unknown;
  create3dmouse(view: HTMLElement | Window, appName: string, options?: number): void;
  delete3dmouse(): void;
  session?: { close(): void } | null;
}

/** The SDK's constructor: `new Sdk(clientObject)`; the client object carries the navigation-model callbacks. */
export type SdkConstructor = new (client: object) => SdkInstance;

/** How the SDK module is obtained. The default is a dynamic `import()`, so nothing is fetched until `connect()`. */
export type SdkLoader = () => Promise<{ default: SdkConstructor }>;

export interface SpaceMouseDriverOptions {
  /** Shown in the 3Dconnexion settings panel as the application's name. */
  appName: string;
  /** Log the SDK's connection and every property the driver requests to the console (off by default). */
  debug?: boolean;
  /** Override how the SDK is loaded (tests, or a bundler setup that needs a custom chunk). */
  loadSdk?: SdkLoader;
}
