/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The embedding host's CLASS-level hide (`store.hostHiddenIfcTypes`, the
 * embed's `hideTypes`) applied to the symbolic overlay's two channel toggles.
 *
 * Read from the store here — inside the hook layer that builds the overlay,
 * beside the per-entity hides `useSymbolicAnnotations` already applies —
 * rather than handed down from `Viewport` as a prop. The overlay is not a
 * mesh, so the embed's mesh filter cannot reach it (#2934); a prop would have
 * added a link that only `Viewport` could keep honest, and no test mounts
 * `Viewport`, which needs a WebGPU device. Split into its own module for the
 * reason `symbolic-line-channels.ts` was: `useSymbolicAnnotations.ts` is at
 * its module-size budget.
 */

import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import {
  symbolicOverlayGate,
  type SymbolicOverlayChannelGate,
} from '../lib/symbolic-overlay-gate.js';

/** Gate the `annotation` / `grid` toggles on the host's hidden classes. */
export function useOverlayChannelGate(
  annotation: boolean,
  grid: boolean,
): SymbolicOverlayChannelGate {
  const hostHidden = useViewerStore((s) => s.hostHiddenIfcTypes);
  return useMemo(
    () => symbolicOverlayGate({ annotation, grid }, hostHidden),
    [annotation, grid, hostHidden],
  );
}
