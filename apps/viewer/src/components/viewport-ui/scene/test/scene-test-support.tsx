/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared test support for the scene-overlay kernel (#5486): a fake rAF
 * scheduler, a stub camera/source, and a harness that mounts the real
 * `SceneOverlayLayers` shell (so `createPortal` in the primitives has
 * somewhere to land) wired to a `SceneProjector` driven by the stub — no
 * `@ifc-lite/renderer`, no WebGPU. Exempt from `check-module-size` (lives
 * under `test/`).
 */

import type { ReactNode } from 'react';
import { render } from '@/test/render';
import { SceneProjector } from '../projector';
import { SceneProjectorContext } from '../SceneProjectorProvider';
import { SceneOverlayLayers } from '../SceneOverlayLayers';
import type { ProjectorCamera, ProjectorSource, ScreenPoint, Vec3 } from '../types';

/** Runs queued rAF callbacks synchronously and deterministically for tests. */
export class FakeFrameScheduler {
  private queue = new Map<number, FrameRequestCallback>();
  private nextHandle = 1;
  private time = 0;

  request = (cb: FrameRequestCallback): number => {
    const handle = this.nextHandle++;
    this.queue.set(handle, cb);
    return handle;
  };

  cancel = (handle: number): void => {
    this.queue.delete(handle);
  };

  /** Run every callback queued right now (a "frame"). Returns how many ran. */
  flush(): number {
    const due = [...this.queue.entries()];
    this.queue.clear();
    this.time += 16;
    for (const [, cb] of due) cb(this.time);
    return due.length;
  }

  get pending(): number {
    return this.queue.size;
  }
}

/** A camera that projects world.x/world.y straight to screen px, ignoring z, unless told to go "behind". */
export class StubCamera implements ProjectorCamera {
  behind = false;
  projectToScreen(worldPos: Vec3): ScreenPoint | null {
    if (this.behind) return null;
    return { x: worldPos.x, y: worldPos.y };
  }
}

export class StubSource implements ProjectorSource {
  camera = new StubCamera();
  canvasSize = { width: 800, height: 600 };
  dirty = false;
  getCamera(): ProjectorCamera | null {
    return this.camera;
  }
  getCanvasSize() {
    return this.canvasSize;
  }
  isDirty(): boolean {
    return this.dirty;
  }
}

export interface SceneTestHarness {
  container: HTMLElement;
  scheduler: FakeFrameScheduler;
  source: StubSource;
  projector: SceneProjector;
  /** Runs one frame of queued projector work; returns how many callbacks ran. */
  flush: () => number;
}

/**
 * Mounts `children` inside the real `SceneOverlayLayers` shell (real
 * portal targets) and a stub-driven `SceneProjector` — everything a
 * primitive needs to project and hide, with full control over the fake
 * clock and camera from the test.
 */
export function renderScene(children: ReactNode): SceneTestHarness {
  const scheduler = new FakeFrameScheduler();
  const source = new StubSource();
  const projector = new SceneProjector(source, { requestFrame: scheduler.request, cancelFrame: scheduler.cancel });

  const container = render(
    <SceneProjectorContext.Provider value={projector}>
      <SceneOverlayLayers>{children}</SceneOverlayLayers>
    </SceneProjectorContext.Provider>,
  );

  return { container, scheduler, source, projector, flush: () => scheduler.flush() };
}
