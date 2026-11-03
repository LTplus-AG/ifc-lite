/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Release gates that keep public Gaussian rendering disabled. */
export type GaussianBlocker =
  | 'exact-mixed-transparency'
  | 'scalable-global-order'
  | 'native-viewer-contract'
  | 'upstream-capability-missing';

/** What the internal, unqualified adapter implements; none of it is a release qualification. */
export type GaussianCapability =
  | 'shared-device'
  | 'viewer-frame'
  | 'reverse-z-order'
  | 'msaa'
  | 'opaque-occlusion'
  | 'packed-global-order'
  | 'similarity-placement'
  | 'sh-rotation'
  | 'rte-anchor'
  | 'centre-clipping'
  | 'non-pickable'
  | 'generation-lifecycle';

/** No ready variant until the native shared-composition contract is qualified. */
export type GaussianReadiness =
  | { state: 'initializing' | 'lost' | 'disposed'; generation: number }
  | {
      state: 'blocked';
      generation: number;
      reasons: readonly GaussianBlocker[];
      /** Always set by the renderer; optional so values built against the earlier shape still type-check. */
      capabilities?: readonly GaussianCapability[];
    };

/** Whether the installed upstream renderer exposes reverse-Z ordering (luma.gl #3619). */
export type GaussianUpstreamStatus = 'unknown' | 'available' | 'missing';

const blockers = Object.freeze([
  'exact-mixed-transparency', 'scalable-global-order', 'native-viewer-contract',
] as const satisfies readonly GaussianBlocker[]);
const missingUpstream = Object.freeze([...blockers, 'upstream-capability-missing'] as const);

const capabilities = Object.freeze([
  'shared-device', 'viewer-frame', 'reverse-z-order', 'msaa', 'opaque-occlusion', 'packed-global-order',
  'similarity-placement', 'sh-rotation', 'rte-anchor', 'centre-clipping', 'non-pickable', 'generation-lifecycle',
] as const satisfies readonly GaussianCapability[]);

/** Uses the renderer's existing lifetime; no second device or readiness latch. */
export function gaussianReadiness(
  ready: boolean, lost: boolean, disposed: boolean, generation: number, upstream: GaussianUpstreamStatus = 'unknown',
): GaussianReadiness {
  if (disposed) return { state: 'disposed', generation };
  if (lost) return { state: 'lost', generation };
  if (!ready) return { state: 'initializing', generation };
  return { state: 'blocked', generation, reasons: upstream === 'missing' ? missingUpstream : blockers, capabilities };
}
