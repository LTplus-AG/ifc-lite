/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StoreGroupNamespace } from './store-group.js';
import type { StructuralStoreBackendMethods } from '../store-structural-types.js';

/** Synchronous structural forwarding stays small on the viewer boot path.
 * The host supplies the builders through its lazy structural write seam.
 */
export interface StoreStructuralNamespace extends Required<StructuralStoreBackendMethods> {}
export class StoreStructuralNamespace extends StoreGroupNamespace {
  static {
    const methods = [
      'addStructuralPlanarAction',
      'addStructuralSurfaceAction',
      'addStructuralPointReaction',
      'addStructuralCurveReaction',
      'addStructuralSurfaceReaction',
      'addStructuralResultGroup',
      'addStructuralAnalysisModel',
      'addStructuralCurveMember',
      'addStructuralPointConnection',
      'addStructuralLoadGroup',
      'addStructuralPointAction',
      'addStructuralLinearAction',
      'connectStructuralMemberToConnection',
      'connectStructuralActivityToItem',
      'assignToStructuralGroup',
    ] as const satisfies readonly (keyof StructuralStoreBackendMethods)[];
    for (const name of methods) {
      Object.defineProperty(this.prototype, name, {
        configurable: true, writable: true,
        value(this: StoreStructuralNamespace, ...args: unknown[]) {
          const method = this.backend.store[name];
          if (!method) throw new Error(`bim.store.${name}: not available on this backend`);
          return Reflect.apply(method, this.backend.store, args);
        },
      });
    }
  }
}
