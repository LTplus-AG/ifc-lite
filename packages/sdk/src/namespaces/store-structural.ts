/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StoreGroupNamespace } from './store-group.js';
import type { StructuralDerivationStoreBackendMethods } from '../store-structural-derive.js';
import type { StructuralStoreBackendMethods } from '../store-structural-types.js';
import type { EntityRef } from '../types.js';

type ForwardedMethods = Required<StructuralStoreBackendMethods>;
type StructuralMethods = ForwardedMethods & Required<StructuralDerivationStoreBackendMethods>;

/** Optional backend capabilities retain their exact argument and result types. */
export interface StoreStructuralNamespace {
  editStructuralEntity(...args: Parameters<StructuralMethods['editStructuralEntity']>): EntityRef;
  removeStructuralEntity(...args: Parameters<StructuralMethods['removeStructuralEntity']>): EntityRef;
  addStructuralPlanarAction(...args: Parameters<StructuralMethods['addStructuralPlanarAction']>): EntityRef;
  addStructuralSurfaceAction(...args: Parameters<StructuralMethods['addStructuralSurfaceAction']>): EntityRef;
  addStructuralPointReaction(...args: Parameters<StructuralMethods['addStructuralPointReaction']>): EntityRef;
  addStructuralCurveReaction(...args: Parameters<StructuralMethods['addStructuralCurveReaction']>): EntityRef;
  addStructuralSurfaceReaction(...args: Parameters<StructuralMethods['addStructuralSurfaceReaction']>): EntityRef;
  addStructuralResultGroup(...args: Parameters<StructuralMethods['addStructuralResultGroup']>): EntityRef;
  addStructuralAnalysisModel(...args: Parameters<StructuralMethods['addStructuralAnalysisModel']>): EntityRef;
  addStructuralCurveMember(...args: Parameters<StructuralMethods['addStructuralCurveMember']>): EntityRef;
  addStructuralPointConnection(...args: Parameters<StructuralMethods['addStructuralPointConnection']>): EntityRef;
  addStructuralLoadGroup(...args: Parameters<StructuralMethods['addStructuralLoadGroup']>): EntityRef;
  addStructuralPointAction(...args: Parameters<StructuralMethods['addStructuralPointAction']>): EntityRef;
  addStructuralLinearAction(...args: Parameters<StructuralMethods['addStructuralLinearAction']>): EntityRef;
  connectStructuralMemberToConnection(...args: Parameters<StructuralMethods['connectStructuralMemberToConnection']>): EntityRef;
  connectStructuralActivityToItem(...args: Parameters<StructuralMethods['connectStructuralActivityToItem']>): EntityRef;
  assignToStructuralGroup(...args: Parameters<StructuralMethods['assignToStructuralGroup']>): EntityRef;
  addStructuralSurfaceMember(...args: Parameters<StructuralMethods['addStructuralSurfaceMember']>): EntityRef;
  addStructuralCurveConnection(...args: Parameters<StructuralMethods['addStructuralCurveConnection']>): EntityRef;
  addStructuralSurfaceConnection(...args: Parameters<StructuralMethods['addStructuralSurfaceConnection']>): EntityRef;
}

/** Synchronous forwarding; implementations stay in the lazy host chunk. */
export class StoreStructuralNamespace extends StoreGroupNamespace {
  static {
    const methods = {
      editStructuralEntity: true,
      removeStructuralEntity: true,
      addStructuralPlanarAction: true,
      addStructuralSurfaceAction: true,
      addStructuralPointReaction: true,
      addStructuralCurveReaction: true,
      addStructuralSurfaceReaction: true,
      addStructuralResultGroup: true,
      addStructuralAnalysisModel: true,
      addStructuralCurveMember: true,
      addStructuralPointConnection: true,
      addStructuralLoadGroup: true,
      addStructuralPointAction: true,
      addStructuralLinearAction: true,
      connectStructuralMemberToConnection: true,
      connectStructuralActivityToItem: true,
      assignToStructuralGroup: true,
      addStructuralSurfaceMember: true,
      addStructuralCurveConnection: true,
      addStructuralSurfaceConnection: true,
    } satisfies Record<keyof ForwardedMethods, true>;
    for (const name of Object.keys(methods) as (keyof ForwardedMethods)[]) {
      Object.defineProperty(this.prototype, name, {
        configurable: true, writable: true,
        value(this: StoreStructuralNamespace, ...args: unknown[]): EntityRef {
          return this.#structural(name, args as Parameters<StructuralMethods[typeof name]>);
        },
      });
    }
  }

  /**
   * Plan an analytical model from the physical one: members, nodes, supports
   * and a report of what was skipped, moved and guessed (#9668). Writes nothing.
   */
  planStructuralDerivation(...args: Parameters<StructuralMethods['planStructuralDerivation']>): ReturnType<StructuralMethods['planStructuralDerivation']> {
    return this.#structural('planStructuralDerivation', args);
  }

  /**
   * Derive and write one IfcStructuralAnalysisModel linked to the physical
   * elements (#9668). Elements already linked to a structural item are skipped;
   * a file with an analysis model is refused unless `whenAnalysisModelExists` is 'add'.
   */
  deriveStructuralAnalysisModel(...args: Parameters<StructuralMethods['deriveStructuralAnalysisModel']>): ReturnType<StructuralMethods['deriveStructuralAnalysisModel']> {
    return this.#structural('deriveStructuralAnalysisModel', args);
  }

  #structural<K extends keyof StructuralMethods>(name: K, args: Parameters<StructuralMethods[K]>): ReturnType<StructuralMethods[K]> {
    const method = this.backend.store[name];
    if (!method) throw new Error(`bim.store.${name}: not available on this backend`);
    return Reflect.apply(method, this.backend.store, args);
  }
}
