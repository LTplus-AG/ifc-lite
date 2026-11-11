/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StoreGroupNamespace } from './store-group.js';
import type { StructuralStoreBackendMethods } from '../store-structural-types.js';
import type { EntityRef } from '../types.js';

type StructuralMethods = Required<StructuralStoreBackendMethods>;

/** Synchronous structural forwarding stays small on the viewer boot path.
 * The host supplies the builders through its lazy structural write seam.
 */
export class StoreStructuralNamespace extends StoreGroupNamespace {
  /** Add a constant IfcStructuralPlanarAction with its own planar-force or temperature load. Supports IFC2X3, IFC4 and IFC4X3 builders; backend schema support applies. */
  addStructuralPlanarAction(...args: Parameters<StructuralMethods['addStructuralPlanarAction']>): EntityRef {
    return this.#structural('addStructuralPlanarAction', args);
  }
  /** Add a constant IfcStructuralSurfaceAction with its own planar-force or temperature load (IFC4+). */
  addStructuralSurfaceAction(...args: Parameters<StructuralMethods['addStructuralSurfaceAction']>): EntityRef {
    return this.#structural('addStructuralSurfaceAction', args);
  }
  /** Add an IfcStructuralPointReaction with its own single-force or single-displacement result. */
  addStructuralPointReaction(...args: Parameters<StructuralMethods['addStructuralPointReaction']>): EntityRef {
    return this.#structural('addStructuralPointReaction', args);
  }
  /** Add a constant IfcStructuralCurveReaction with its own linear-force result (IFC4+). */
  addStructuralCurveReaction(...args: Parameters<StructuralMethods['addStructuralCurveReaction']>): EntityRef {
    return this.#structural('addStructuralCurveReaction', args);
  }
  /** Add a constant IfcStructuralSurfaceReaction with its own planar-force result (IFC4+). */
  addStructuralSurfaceReaction(...args: Parameters<StructuralMethods['addStructuralSurfaceReaction']>): EntityRef {
    return this.#structural('addStructuralSurfaceReaction', args);
  }
  /** Add an IfcStructuralResultGroup for ResultForLoadGroup and assign ReactionIds in one relationship. */
  addStructuralResultGroup(...args: Parameters<StructuralMethods['addStructuralResultGroup']>): EntityRef {
    return this.#structural('addStructuralResultGroup', args);
  }
  /** Add an IfcStructuralAnalysisModel. Not storey-anchored (IfcGroup, no geometry). */
  addStructuralAnalysisModel(...args: Parameters<StructuralMethods['addStructuralAnalysisModel']>): EntityRef {
    return this.#structural('addStructuralAnalysisModel', args);
  }
  /**
   * Add an IfcStructuralCurveMember between `params.Start` and `params.End`,
   * anchored to a storey for its ObjectPlacement. Emits an
   * IfcTopologyRepresentation (IfcEdge between two IfcVertexPoints) as its
   * analytical line geometry.
   */
  addStructuralCurveMember(...args: Parameters<StructuralMethods['addStructuralCurveMember']>): EntityRef {
    return this.#structural('addStructuralCurveMember', args);
  }
  /** Add an IfcStructuralPointConnection at `params.Position`, optionally with an IfcBoundaryNodeCondition. */
  addStructuralPointConnection(...args: Parameters<StructuralMethods['addStructuralPointConnection']>): EntityRef {
    return this.#structural('addStructuralPointConnection', args);
  }
  /** Add an IfcStructuralLoadGroup, or an IfcStructuralLoadCase when `params.SelfWeightCoefficients` is given. */
  addStructuralLoadGroup(...args: Parameters<StructuralMethods['addStructuralLoadGroup']>): EntityRef {
    return this.#structural('addStructuralLoadGroup', args);
  }
  /** Add an IfcStructuralPointAction carrying an IfcStructuralLoadSingleForce. */
  addStructuralPointAction(...args: Parameters<StructuralMethods['addStructuralPointAction']>): EntityRef {
    return this.#structural('addStructuralPointAction', args);
  }
  /** Add an IfcStructuralLinearAction carrying an IfcStructuralLoadLinearForce. */
  addStructuralLinearAction(...args: Parameters<StructuralMethods['addStructuralLinearAction']>): EntityRef {
    return this.#structural('addStructuralLinearAction', args);
  }
  /** Link a structural member to a structural connection via IfcRelConnectsStructuralMember. */
  connectStructuralMemberToConnection(...args: Parameters<StructuralMethods['connectStructuralMemberToConnection']>): EntityRef {
    return this.#structural('connectStructuralMemberToConnection', args);
  }
  /** Apply a structural action/reaction to the member or connection it acts on via IfcRelConnectsStructuralActivity. */
  connectStructuralActivityToItem(...args: Parameters<StructuralMethods['connectStructuralActivityToItem']>): EntityRef {
    return this.#structural('connectStructuralActivityToItem', args);
  }
  /**
   * Assign members/connections into an analysis model, or activities into a
   * load group, via IfcRelAssignsToGroup — the relationship
   * `bim.structural.analysisModels()[i].itemGlobalIds` and
   * `bim.structural.loadGroups()[i].activityGlobalIds` read back.
   */
  assignToStructuralGroup(...args: Parameters<StructuralMethods['assignToStructuralGroup']>): EntityRef {
    return this.#structural('assignToStructuralGroup', args);
  }

  /** Add an IfcStructuralSurfaceMember anchored to a storey. Throws when the backend does not implement it. */
  addStructuralSurfaceMember(...args: Parameters<StructuralMethods['addStructuralSurfaceMember']>): EntityRef {
    return this.#structural('addStructuralSurfaceMember', args);
  }

  /** Add an IfcStructuralCurveConnection anchored to a storey. Throws when the backend does not implement it. */
  addStructuralCurveConnection(...args: Parameters<StructuralMethods['addStructuralCurveConnection']>): EntityRef {
    return this.#structural('addStructuralCurveConnection', args);
  }

  /** Add an IfcStructuralSurfaceConnection anchored to a storey. Throws when the backend does not implement it. */
  addStructuralSurfaceConnection(...args: Parameters<StructuralMethods['addStructuralSurfaceConnection']>): EntityRef {
    return this.#structural('addStructuralSurfaceConnection', args);
  }

  #structural<K extends keyof StructuralMethods>(name: K, args: Parameters<StructuralMethods[K]>): EntityRef {
    const method = this.backend.store[name];
    if (!method) throw new Error(`bim.store.${name}: not available on this backend`);
    return Reflect.apply(method, this.backend.store, args);
  }
}
