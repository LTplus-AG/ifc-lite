/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * bim.physics — rigid-body what-if simulations.
 *
 * Usage:
 *   const result = bim.physics.simulate({ remove: [columnRef.expressId] });
 *   bim.viewer.colorize(result.falling.map(id => ({ modelId, expressId: id })), '#dc2626');
 *
 * Plausibility check, not structural engineering — no bending or material
 * yield. See `@ifc-lite/physics` for the full contract.
 */

import type {
  BimBackend,
  PhysicsSimulateOptions,
  PhysicsSimulationResult,
} from '../types.js';

export class PhysicsNamespace {
  constructor(private backend: BimBackend) {}

  /**
   * Run a rigid-body simulation against the active model (or the named one).
   *
   * Single-model only at the moment — federated multi-model simulation is
   * intentionally out of scope for v1.
   */
  simulate(options?: PhysicsSimulateOptions): PhysicsSimulationResult;
  simulate(modelId: string, options?: PhysicsSimulateOptions): PhysicsSimulationResult;
  simulate(
    arg1?: string | PhysicsSimulateOptions,
    arg2?: PhysicsSimulateOptions,
  ): PhysicsSimulationResult {
    if (typeof arg1 === 'string') {
      return this.backend.physics.simulate(arg1, arg2 ?? {});
    }
    return this.backend.physics.simulate(null, arg1 ?? {});
  }
}
