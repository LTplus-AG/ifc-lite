/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `@ifc-lite/physics` — rigid-body what-if simulations for IFC models.
 *
 * Quick start:
 * ```ts
 * import { init, simulate } from '@ifc-lite/physics';
 *
 * await init(); // boots the Rapier WASM module — once per process
 *
 * const result = simulate(meshes, { remove: [columnExpressId] });
 * console.log(`${result.falling.length} elements would fall`);
 * ```
 *
 * This is a *plausibility check*, not engineering analysis: no bending,
 * buckling, material yield, or dynamic loading. Route real structural
 * checks through `IfcStructuralAnalysisModel` and an FEM solver.
 */

export { init, simulate, simulateAsync } from './simulate.js';
export { meshAABB, aabbCenter, aabbTouches } from './aabb.js';
export { classifyAnchor, densityFor } from './anchor.js';
export {
  DEFAULT_OPTIONS,
  resolveOptions,
} from './types.js';
export type {
  AABB,
  AnchorReason,
  BodyOutcome,
  PhysicsMesh,
  ResolvedSimulateOptions,
  SimulateOptions,
  SimulationResult,
  Stability,
} from './types.js';
