/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StoreGroupNamespace } from './store-group.js';
import type { StructuralStoreBackendMethods } from '../store-structural-types.js';

/** Synchronous structural forwarding stays small on the viewer boot path.
 * The host supplies the builders through its lazy structural write seam.
 */
export class StoreStructuralNamespace extends StoreGroupNamespace {
  /** Add a constant IfcStructuralPlanarAction with its own planar-force or temperature load. Supports IFC2X3, IFC4 and IFC4X3 builders; backend schema support applies. */
  declare addStructuralPlanarAction: Required<StructuralStoreBackendMethods>['addStructuralPlanarAction'];
  /** Add a constant IfcStructuralSurfaceAction with its own planar-force or temperature load (IFC4+). */
  declare addStructuralSurfaceAction: Required<StructuralStoreBackendMethods>['addStructuralSurfaceAction'];
  /** Add an IfcStructuralPointReaction with its own single-force or single-displacement result. */
  declare addStructuralPointReaction: Required<StructuralStoreBackendMethods>['addStructuralPointReaction'];
  /** Add a constant IfcStructuralCurveReaction with its own linear-force result (IFC4+). */
  declare addStructuralCurveReaction: Required<StructuralStoreBackendMethods>['addStructuralCurveReaction'];
  /** Add a constant IfcStructuralSurfaceReaction with its own planar-force result (IFC4+). */
  declare addStructuralSurfaceReaction: Required<StructuralStoreBackendMethods>['addStructuralSurfaceReaction'];
  /** Add an IfcStructuralResultGroup for ResultForLoadGroup and assign ReactionIds in one relationship. */
  declare addStructuralResultGroup: Required<StructuralStoreBackendMethods>['addStructuralResultGroup'];
  /** Add an IfcStructuralAnalysisModel. Not storey-anchored (IfcGroup, no geometry). */
  declare addStructuralAnalysisModel: Required<StructuralStoreBackendMethods>['addStructuralAnalysisModel'];
  /**
   * Add an IfcStructuralCurveMember between `params.Start` and `params.End`,
   * anchored to a storey for its ObjectPlacement. Emits an
   * IfcTopologyRepresentation (IfcEdge between two IfcVertexPoints) as its
   * analytical line geometry.
   */
  declare addStructuralCurveMember: Required<StructuralStoreBackendMethods>['addStructuralCurveMember'];
  /** Add an IfcStructuralPointConnection at `params.Position`, optionally with an IfcBoundaryNodeCondition. */
  declare addStructuralPointConnection: Required<StructuralStoreBackendMethods>['addStructuralPointConnection'];
  /** Add an IfcStructuralLoadGroup, or an IfcStructuralLoadCase when `params.SelfWeightCoefficients` is given. */
  declare addStructuralLoadGroup: Required<StructuralStoreBackendMethods>['addStructuralLoadGroup'];
  /** Add an IfcStructuralPointAction carrying an IfcStructuralLoadSingleForce. */
  declare addStructuralPointAction: Required<StructuralStoreBackendMethods>['addStructuralPointAction'];
  /** Add an IfcStructuralLinearAction carrying an IfcStructuralLoadLinearForce. */
  declare addStructuralLinearAction: Required<StructuralStoreBackendMethods>['addStructuralLinearAction'];
  /** Link a structural member to a structural connection via IfcRelConnectsStructuralMember. */
  declare connectStructuralMemberToConnection: Required<StructuralStoreBackendMethods>['connectStructuralMemberToConnection'];
  /** Apply a structural action/reaction to the member or connection it acts on via IfcRelConnectsStructuralActivity. */
  declare connectStructuralActivityToItem: Required<StructuralStoreBackendMethods>['connectStructuralActivityToItem'];
  /**
   * Assign members/connections into an analysis model, or activities into a
   * load group, via IfcRelAssignsToGroup — the relationship
   * `bim.structural.analysisModels()[i].itemGlobalIds` and
   * `bim.structural.loadGroups()[i].activityGlobalIds` read back.
   */
  declare assignToStructuralGroup: Required<StructuralStoreBackendMethods>['assignToStructuralGroup'];

  /** Add an IfcStructuralSurfaceMember anchored to a storey. Throws when the backend does not implement it. */
  declare addStructuralSurfaceMember: Required<StructuralStoreBackendMethods>['addStructuralSurfaceMember'];

  /** Add an IfcStructuralCurveConnection anchored to a storey. Throws when the backend does not implement it. */
  declare addStructuralCurveConnection: Required<StructuralStoreBackendMethods>['addStructuralCurveConnection'];

  /** Add an IfcStructuralSurfaceConnection anchored to a storey. Throws when the backend does not implement it. */
  declare addStructuralSurfaceConnection: Required<StructuralStoreBackendMethods>['addStructuralSurfaceConnection'];

  static {
    const methods = [
      'addStructuralSurfaceConnection',
      'addStructuralCurveConnection',
      'addStructuralSurfaceMember',
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
