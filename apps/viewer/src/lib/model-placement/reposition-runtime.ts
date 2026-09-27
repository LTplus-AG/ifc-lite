/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The local-reposition session's own UI state (which models are picked, the
 * reference model, the typed move fields, the source/target pick role, the
 * hover readout) — everything the former floating `RepositionPanel` held
 * locally, alongside the store-held `modelPlacement` preview. Published by
 * `RepositionRuntimeHost` (mounted in `ToolOverlays`, next to the scene
 * gizmo + hover marker + keyboard shortcuts) so the docked `placement`
 * panel's Local tab (#5505, mounted separately in the sidebar/float/pop-out)
 * can read and drive it. Same `useSyncExternalStore` shape as
 * `lib/drawing/drawing-runtime.ts` (#5492) and `lib/geo/placement-georef-runtime.ts`.
 */
import { useSyncExternalStore } from 'react';
import type { PlacementAnchor } from './state';
import type { PickRole } from '../../components/viewer/reposition/useRepositionPicking';

export interface RepositionRuntime {
  /** The moving models, tracked separately from `modelPlacement.preview`
   * because a few store commands (rotation apply, in particular) cancel the
   * preview as a side effect without ending the session — `selected` must
   * survive that so the model list, framing buttons and `RotationControls`
   * don't collapse to empty for a frame. */
  selected: readonly string[];
  reference: string;
  fields: readonly [string, string, string];
  mode: 'delta' | 'absolute';
  nudgeField: string;
  error: string;
  distance: string;
  role: PickRole;
  hover: PlacementAnchor | null;
  setError: (message: string) => void;
  setReference: (id: string) => void;
  setFieldAt: (index: number, value: string) => void;
  setMode: (mode: 'delta' | 'absolute') => void;
  setNudgeField: (value: string) => void;
  setDistance: (value: string) => void;
  setRole: (role: PickRole) => void;
  chooseModels: (ids: readonly string[]) => void;
  previewFields: () => void;
  previewDistance: () => void;
  nearReference: () => void;
  applyNudge: () => void;
  apply: () => void;
}

let runtime: RepositionRuntime | null = null;
const listeners = new Set<() => void>();

export function publishRepositionRuntime(next: RepositionRuntime | null): void {
  runtime = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getRuntime(): RepositionRuntime | null {
  return runtime;
}

export function useRepositionRuntime(): RepositionRuntime | null {
  return useSyncExternalStore(subscribe, getRuntime, getRuntime);
}
