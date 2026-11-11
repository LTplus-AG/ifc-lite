/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The apply step: write a derivation plan with the structural builders. All
 * refusals happen before the first write; the builders' own checks already
 * ran on every boundary in the plan step.
 */

import type { RandomSource } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import { structuralCounterparts, type IfcDataStore } from '@ifc-lite/parser';
import type { SpatialAnchor } from './anchor.js';
import { applyFrame, inverseFrame, placementInAncestor } from './host-geometry-frame.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { createStyleEntityReader } from './style-entity-reader.js';
import { addStructuralAnalysisModelToStore } from './structural-analysis-model.js';
import { addStructuralCurveMemberToStore } from './structural-curve-member.js';
import { liveStructuralExtraction } from './structural-derive-facts.js';
import { DERIVED_ANALYSIS_MODEL_DESCRIPTION, type StructuralDerivationApplied, type StructuralDerivationPlan, type SupportType, type Vec3 } from './structural-derive-types.js';
import { linkStructuralItemsToPhysicalInStore } from './structural-physical-link.js';
import { addStructuralPointConnectionToStore, type StructuralBoundaryConditionParams } from './structural-point-connection.js';
import { assignToStructuralGroupInStore, connectStructuralMemberToConnectionInStore } from './structural-relationships.js';
import { addStructuralSurfaceMemberToStore } from './structural-surface-member.js';

function boundaryCondition(type: SupportType): StructuralBoundaryConditionParams {
  const rotation = type === 'fixed';
  return {
    Name: type === 'fixed' ? 'Fixed' : 'Pinned',
    TranslationalStiffnessX: true, TranslationalStiffnessY: true, TranslationalStiffnessZ: true,
    RotationalStiffnessX: rotation, RotationalStiffnessY: rotation, RotationalStiffnessZ: rotation,
  };
}

interface StoreyPlacement { anchor: SpatialAnchor; toLocal(p: Vec3): Vec3 }

export function applyStructuralDerivation(
  editor: StoreEditor,
  store: IfcDataStore,
  plan: StructuralDerivationPlan,
  random?: RandomSource,
): StructuralDerivationApplied {
  if (plan.curveMembers.length + plan.surfaceMembers.length === 0) {
    throw new Error('Structural derivation: the plan has no members to write');
  }
  const view = editor.getMutationView();
  const structural = liveStructuralExtraction(store, view);
  // Read live, not from the plan: a derived model may have been written since it was made.
  const derived = structural.analysisModels.find((model) => model.description === DERIVED_ANALYSIS_MODEL_DESCRIPTION);
  if (derived) {
    throw new Error(`Structural derivation: the model already has a derived analysis model (#${derived.expressId}); a second one would not connect to it`);
  }
  for (const footingId of plan.nodes.flatMap((node) => node.support?.footingId ?? [])) {
    if (!editor.hasEntity(footingId)) throw new Error(`Structural derivation: footing #${footingId} no longer exists; plan again`);
  }
  for (const { elementId } of [...plan.curveMembers, ...plan.surfaceMembers]) {
    if (!editor.hasEntity(elementId)) throw new Error(`Structural derivation: element #${elementId} no longer exists; plan again`);
    if (structuralCounterparts(structural, elementId)?.side === 'analytical') {
      throw new Error(`Structural derivation: element #${elementId} was idealised after this plan was made; plan again`);
    }
  }

  const reader = { entity: createStyleEntityReader(store, editor) };
  const placements = new Map<number, StoreyPlacement>();
  const placementOf = (storeyId: number | null): StoreyPlacement => {
    const id = storeyId ?? plan.defaultStoreyId;
    if (id === null) throw new Error('Structural derivation: the model has no storey to place structural items on');
    let placed = placements.get(id);
    if (!placed) {
      const anchor = resolveSpatialAnchor(store, id, view);
      if (random) anchor.guidRandom = random;
      const frame = placementInAncestor(reader, anchor.storeyPlacementId, null);
      if (!frame) throw new Error(`Structural derivation: storey #${id} has an unreadable placement`);
      const metres = anchor.lengthUnitScale && anchor.lengthUnitScale > 0 ? anchor.lengthUnitScale : 1;
      const inverse = inverseFrame({ ...frame, o: frame.o.map((v) => v * metres) as Vec3 });
      placed = { anchor, toLocal: (p) => applyFrame(inverse, p) };
      placements.set(id, placed);
    }
    return placed;
  };
  // Resolve every anchor before the first write, so a refusal writes nothing.
  const [first] = [...plan.curveMembers, ...plan.surfaceMembers, ...plan.nodes].map((item) => placementOf(item.storeyId).anchor);
  const ownerHistoryId = first.ownerHistoryId;
  const { analysisModelId } = addStructuralAnalysisModelToStore(editor, first, {
    Name: 'Derived analysis model', Description: DERIVED_ANALYSIS_MODEL_DESCRIPTION, PredefinedType: 'LOADING_3D',
  });

  const links = new Map<number, number[]>();
  const link = (elementId: number, itemId: number) => {
    const items = links.get(elementId);
    if (items) items.push(itemId);
    else links.set(elementId, [itemId]);
  };

  const connectionIds = plan.nodes.map((node) => {
    const { anchor, toLocal } = placementOf(node.storeyId);
    const { connectionId } = addStructuralPointConnectionToStore(editor, anchor, {
      Position: toLocal(node.position),
      Name: `${node.support ? 'Support' : 'Node'} ${node.index + 1}`,
      ...node.support ? { BoundaryCondition: boundaryCondition(node.support.type) } : {},
    });
    for (const elementId of node.elementIds) link(elementId, connectionId);
    if (node.support?.footingId !== undefined) link(node.support.footingId, connectionId);
    return connectionId;
  });

  const memberIds: number[] = [];
  for (const member of plan.curveMembers) {
    const { anchor, toLocal } = placementOf(member.storeyId);
    const { memberId } = addStructuralCurveMemberToStore(editor, anchor, {
      Start: toLocal(member.start), End: toLocal(member.end), PredefinedType: 'RIGID_JOINED_MEMBER',
    });
    connectStructuralMemberToConnectionInStore(editor, ownerHistoryId, memberId, connectionIds[member.startNode], random);
    connectStructuralMemberToConnectionInStore(editor, ownerHistoryId, memberId, connectionIds[member.endNode], random);
    memberIds.push(memberId);
    link(member.elementId, memberId);
  }
  for (const member of plan.surfaceMembers) {
    const { anchor, toLocal } = placementOf(member.storeyId);
    const { memberId } = addStructuralSurfaceMemberToStore(editor, anchor, {
      Boundary: member.boundary.map(toLocal), Thickness: member.thickness, PredefinedType: 'SHELL',
    });
    memberIds.push(memberId);
    link(member.elementId, memberId);
  }

  for (const [elementId, itemIds] of links) linkStructuralItemsToPhysicalInStore(editor, ownerHistoryId, elementId, itemIds, random);
  // One relationship for the whole group: IFC2X3 allows only one per group.
  assignToStructuralGroupInStore(editor, ownerHistoryId, analysisModelId, [...memberIds, ...connectionIds], random);
  return { analysisModelId };
}
