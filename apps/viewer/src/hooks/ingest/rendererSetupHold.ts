/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The renderer's device, requested at the pick, and when its setup may start (#9825, pre-pixel lane).
 *
 * On a fresh page the viewport mounts with the load's interface reset. Requesting the device at the pick
 * makes it ready right after the reset, 100-260 ms earlier. The renderer's setup that follows (canvas,
 * pipelines, picker: ~50-80 ms on the main thread) then landed exactly where a cold load reads its file and
 * starts its workers, and the whole cold pipeline moved later (FZK cold +28 ms to first frame,
 * advanced_model +55 ms; traced 2026-11-12). So the device is requested at once, but setup is held until
 * the load knows which path it is on:
 *  - a servable cache hit: setup starts at once, the stored scene needs it;
 *  - a cold IFC load: setup starts once its geometry workers and parser are started, which is where it
 *    used to run, beside them;
 *  - anything else (not a STEP file, another kernel, the server path, an error, a superseded load): the
 *    load's exits release it.
 * The renderer waits at most SETUP_GATE_MAX_MS (1 s) on a gate nobody opens.
 *
 * `asked` is the pick's one bounded await (the device request in flight before the reset blocks the main
 * thread); the shared pick hook can register it as its yield without any change in behaviour.
 */

import { prerequestRendererDevice } from '@ifc-lite/renderer';

/** Why the setup was let go; each release leaves a `renderer.setupReleased:<reason>` performance mark. */
export type RendererSetupRelease = 'cache-hit' | 'cold-geometry' | 'other-path' | 'load-ended';

export interface PickRendererDevice {
  /** Resolves once `requestDevice` is in flight (at most 50 ms); null when nothing was requested. */
  readonly asked: Promise<void> | null;
  /** Let the renderer start its setup. Idempotent: the first reason wins. */
  release(reason: RendererSetupRelease): void;
  /** The reason it was released, or null while held (or when nothing was requested). */
  released(): RendererSetupRelease | null;
}

const NOTHING_HELD: PickRendererDevice = { asked: null, release() {}, released: () => null };

/** At the pick: request the device when no renderer is mounted, holding its setup until {@link PickRendererDevice.release}. */
export function pickRendererDevice(rendererMounted: boolean): PickRendererDevice {
  if (rendererMounted) return NOTHING_HELD;
  let open!: () => void;
  const setupGate = new Promise<void>((resolve) => { open = resolve; });
  const asked = prerequestRendererDevice({ setupGate });
  if (!asked) return NOTHING_HELD; // an earlier pick's request is pending; its own load releases it
  let reason: RendererSetupRelease | null = null;
  return {
    asked,
    release(why) {
      if (reason) return;
      reason = why;
      performance.mark(`renderer.setupReleased:${why}`);
      open();
    },
    released: () => reason,
  };
}
