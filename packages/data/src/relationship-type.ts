/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Relationship kinds stored in the bidirectional relationship graph. */
export enum RelationshipType {
  ContainsElements = 1,
  Aggregates = 2,
  /** `IfcRelNests`; also recorded under {@link Aggregates} (#4205). */
  Nests = 3,
  ProjectsElement = 4,
  AdheresToElement = 5,
  DefinesByProperties = 10,
  DefinesByType = 11,
  AssociatesMaterial = 20,
  AssociatesClassification = 30,
  AssociatesDocument = 31,
  AssociatesConstraint = 32,
  AssociatesApproval = 33,
  AssociatesLibrary = 34,
  ConnectsPathElements = 40,
  FillsElement = 41,
  VoidsElement = 42,
  ConnectsElements = 43,
  /** `IfcRelConnectsPortToElement` — a port belongs to the element it sits on.
   * Forward runs port → element (RelatingPort, RelatedElement). */
  ConnectsPortToElement = 44,
  /** `IfcRelConnectsPorts` — one port joined to another; with
   * {@link ConnectsPortToElement} makes plant topology traversable. */
  ConnectsPorts = 45,
  InterferesElements = 46,
  CoversBldgElements = 47,
  CoversSpaces = 48,
  ServicesBuildings = 49,
  SpaceBoundary = 50,
  AssignsToGroup = 60,
  AssignsToProduct = 61,
  /** `IfcRelAssignsToGroupByFactor`; also recorded under {@link AssignsToGroup} (#4205). */
  AssignsToGroupByFactor = 62,
  /** `IfcRelAssignsToActor` (#4205). */ AssignsToActor = 63,
  /** `IfcRelAssignsToResource` (#4205). */ AssignsToResource = 64,
  /** `IfcRelAssignsToProcess` (#4205). */ AssignsToProcess = 65,
  /** `IfcRelAssignsToControl` (#4205). */ AssignsToControl = 66,
  ReferencedInSpatialStructure = 70,
  /** `IfcRelDeclares` (#4205). */ Declares = 80,
  /** `IfcRelPositions` — IFC4X3 only (#4205). */ Positions = 90,
  /** `IfcRelFlowControlElements` (#4205). */ FlowControlElements = 91,
  /** `IfcRelSequence` (#4205). */ Sequence = 92,
}

const NAMES: Readonly<Record<RelationshipType, string>> = {
  [RelationshipType.ContainsElements]: 'IfcRelContainedInSpatialStructure',
  [RelationshipType.Aggregates]: 'IfcRelAggregates',
  [RelationshipType.Nests]: 'IfcRelNests',
  [RelationshipType.ProjectsElement]: 'IfcRelProjectsElement',
  [RelationshipType.AdheresToElement]: 'IfcRelAdheresToElement',
  [RelationshipType.DefinesByProperties]: 'IfcRelDefinesByProperties',
  [RelationshipType.DefinesByType]: 'IfcRelDefinesByType',
  [RelationshipType.AssociatesMaterial]: 'IfcRelAssociatesMaterial',
  [RelationshipType.AssociatesClassification]: 'IfcRelAssociatesClassification',
  [RelationshipType.AssociatesDocument]: 'IfcRelAssociatesDocument',
  [RelationshipType.AssociatesConstraint]: 'IfcRelAssociatesConstraint',
  [RelationshipType.AssociatesApproval]: 'IfcRelAssociatesApproval',
  [RelationshipType.AssociatesLibrary]: 'IfcRelAssociatesLibrary',
  [RelationshipType.ConnectsPathElements]: 'IfcRelConnectsPathElements',
  [RelationshipType.FillsElement]: 'IfcRelFillsElement',
  [RelationshipType.VoidsElement]: 'IfcRelVoidsElement',
  [RelationshipType.ConnectsElements]: 'IfcRelConnectsElements',
  [RelationshipType.ConnectsPortToElement]: 'IfcRelConnectsPortToElement',
  [RelationshipType.ConnectsPorts]: 'IfcRelConnectsPorts',
  [RelationshipType.InterferesElements]: 'IfcRelInterferesElements',
  [RelationshipType.CoversBldgElements]: 'IfcRelCoversBldgElements',
  [RelationshipType.CoversSpaces]: 'IfcRelCoversSpaces',
  [RelationshipType.ServicesBuildings]: 'IfcRelServicesBuildings',
  [RelationshipType.SpaceBoundary]: 'IfcRelSpaceBoundary',
  [RelationshipType.AssignsToGroup]: 'IfcRelAssignsToGroup',
  [RelationshipType.AssignsToProduct]: 'IfcRelAssignsToProduct',
  [RelationshipType.AssignsToGroupByFactor]: 'IfcRelAssignsToGroupByFactor',
  [RelationshipType.AssignsToActor]: 'IfcRelAssignsToActor',
  [RelationshipType.AssignsToResource]: 'IfcRelAssignsToResource',
  [RelationshipType.AssignsToProcess]: 'IfcRelAssignsToProcess',
  [RelationshipType.AssignsToControl]: 'IfcRelAssignsToControl',
  [RelationshipType.ReferencedInSpatialStructure]: 'IfcRelReferencedInSpatialStructure',
  [RelationshipType.Declares]: 'IfcRelDeclares',
  [RelationshipType.Positions]: 'IfcRelPositions',
  [RelationshipType.FlowControlElements]: 'IfcRelFlowControlElements',
  [RelationshipType.Sequence]: 'IfcRelSequence',
};

/** Return the exact IFC EXPRESS entity name for a stored relationship kind. */
export function relationshipTypeName(type: RelationshipType): string {
  return NAMES[type] ?? 'Unknown';
}
