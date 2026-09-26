/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The active orbit gesture's fixed world pivot (#5891). */
export interface OrbitPivotState {
  point: { x: number; y: number; z: number };
  canvas: HTMLCanvasElement;
  camera: {
    projectToScreen(point: { x: number; y: number; z: number }, width: number, height: number): { x: number; y: number } | null;
  };
}

let current: OrbitPivotState | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Per-gesture state changes only; screen projection never publishes React updates. */
export const orbitPivotStore = {
  getSnapshot: (): OrbitPivotState | null => current,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  begin(next: OrbitPivotState): void {
    current = next;
    notify();
  },
  end(): void {
    if (current === null) return;
    current = null;
    notify();
  },
};
