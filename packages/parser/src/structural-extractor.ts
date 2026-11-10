/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Structural analysis extractor — parses IfcStructuralAnalysisModel,
 * IfcStructuralMember / IfcStructuralConnection subtypes, IfcStructuralAction /
 * IfcStructuralReaction subtypes, IfcStructuralLoadGroup / IfcStructuralLoadCase,
 * IfcStructuralResultGroup, IfcBoundaryCondition, IfcRelConnectsStructuralMember,
 * IfcRelConnectsStructuralActivity, IfcRelAssignsToGroup and the physical links
 * (`structural-relations.ts`) into a connected `StructuralExtraction`.
 *
 * On-demand, like the schedule extractor: nothing here runs during a normal
 * parse, and a model with no structural entity costs one `byType` sweep.
 *
 * The structural relationships are read from the type index directly rather
 * than from the relationship graph, because that graph's `REL_TYPE_MAP`
 * carries none of them — the rows are retained, but nothing indexes
 * member↔connection or item↔activity edges for a query traversal to follow.
 *
 * Two things are schema-derived rather than hand-tabulated, because the
 * alternative is a table that silently mis-reads the next subtype to appear:
 *
 * - **Which types count.** Every `IFCSTRUCTURAL*` key in the type index is
 *   classified by its inheritance chain, so `IfcStructuralCurveMemberVarying`
 *   is a member and `IfcStructuralLinearAction` is an action without either
 *   being named here.
 * - **Where each attribute sits.** Positions come from the file's own schema
 *   by EXPRESS attribute name, never from a literal index, so IFC2X3's
 *   `LinearStiffness*` / `DeltaT_*` names read in place, and one the file's
 *   schema does not declare (IFC2X3 `Axis`) reads as absent.
 */

import { EntityExtractor } from './entity-extractor.js';
import { exactTypeName, iterateEffectiveEntities, type EffectiveEntityOverlay } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { normalizeIfcTypeName } from './ifc-schema.js';
import { getEntityRefFromStore } from './columnar-parser-root-attributes.js';
import {
  extractBoundaryCondition,
  extractStructuralLoad,
  type BoundaryConditionInfo,
  type StructuralLoadConfigurationEntry,
  type StructuralLoadConfigurationInfo,
  type StructuralLoadDropReason,
  type StructuralLoadInfo,
} from './structural-load-extractor.js';
import {
  addUnique,
  asBoolean,
  asEnum,
  asNumber,
  asNumberList,
  asRef,
  asRefList,
  asString,
  readAttr as readSchemaAttr,
  type RawEntity,
} from './structural-step-values.js';
import { MEMBER_RELATION_TYPES, PHYSICAL_LINK_TYPES, STRUCTURAL_RELATION_TYPES as RELATION_TYPES,
  readMemberRelations, readPhysicalLinks, type StructuralRelationContext } from './structural-relations.js';
import type {
  StructuralActivityInfo,
  StructuralAnalysisModelInfo,
  StructuralConnectionInfo,
  StructuralExtraction,
  StructuralLoadGroupInfo,
  StructuralMemberInfo,
  StructuralResultGroupInfo,
} from './structural-types.js';
import {
  emptyStructuralExtraction as emptyExtraction,
  structuralActivityKind as activityKind,
  structuralRoleOf as roleOf,
  structuralRootFields as rootFields,
  type StructuralRole,
} from './structural-extractor-values.js';

export type {
  BoundaryConditionInfo,
  StructuralActivityInfo,
  StructuralAnalysisModelInfo,
  StructuralConnectionInfo,
  StructuralExtraction,
  StructuralLoadConfigurationEntry,
  StructuralLoadConfigurationInfo,
  StructuralLoadDropReason,
  StructuralLoadGroupInfo,
  StructuralLoadInfo,
  StructuralMemberInfo,
  StructuralResultGroupInfo,
};

/** Optional live-session view used when structural data is queried in the viewer. */
export interface StructuralExtractionView extends EffectiveEntityOverlay {
  getNewEntity?(expressId: number): { readonly type: string; readonly attributes?: readonly unknown[] } | null;
  /**
   * Resolve the attributes for an effective entity. `source` is absent for a
   * session-created entity. Callers can merge positional/named edits without
   * making parser depend on the mutations package.
   */
  readEntity?: (expressId: number, effectiveType: string, source?: RawEntity) => RawEntity | undefined;
}

/**
 * Extract all structural analysis data from a parsed IFC store.
 */
export function extractStructuralOnDemand(
  store: IfcDataStore,
  view?: StructuralExtractionView | null,
): StructuralExtraction {
  if (!store.source?.length && !view) return emptyExtraction();

  const readAttr = (type: string, attrs: unknown[], name: string): unknown =>
    readSchemaAttr(type, attrs, name, store.schemaVersion);
  // @raw-entity-enumeration-ok source buckets define the candidate domain; iterateEffectiveEntities below applies tombstones, creations and retypes
  const byType = store.entityIndex.byType;

  // Candidate source ids are the structural classes plus the relation classes
  // below. The effective iterator removes tombstones and folds in created and
  // retyped records before the extractor reads their attributes.
  const sourceIds = new Set<number>();
  for (const [typeKey, ids] of byType) {
    if (!typeKey.startsWith('IFCSTRUCTURAL')) continue;
    const role = roleOf(typeKey);
    if (!role) continue;
    for (const id of ids) sourceIds.add(id);
  }

  for (const type of RELATION_TYPES) for (const id of byType.get(type) ?? []) sourceIds.add(id);
  const typeMutations = view?.getTypeMutations?.();
  for (const [id, mutation] of typeMutations ?? []) {
    if (roleOf(mutation.newType) || RELATION_TYPES.includes(mutation.newType.toUpperCase())) sourceIds.add(id);
  }
  const effectiveRows = [...iterateEffectiveEntities(store, view, undefined, sourceIds)];
  // Preserve the common no-structural-data path without setting up a source
  // extractor. Created/retyped structural entities are already in this set.
  if (!effectiveRows.some((row) => roleOf(row.type))) return emptyExtraction();
  const extractor = new EntityExtractor(store.source);
  const effectiveTypeById = new Map(effectiveRows.map((row) => [row.expressId, row.type]));
  const readRaw = (id: number, effectiveType: string): RawEntity | undefined => {
    // @raw-entity-enumeration-ok the effective iterator chose this one record; source bytes supply its baseline attributes
    const ref = store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id);
    const entity = ref ? extractor.extractEntity(ref) : undefined;
    const created = !entity ? view?.getNewEntity?.(id) : null;
    const source = entity ? {
      expressId: id,
      type: normalizeIfcTypeName(effectiveType),
      attrs: entity.attributes ?? [],
      globalId: asString(entity.attributes?.[0]) ?? '',
    } : created ? {
      expressId: id,
      type: normalizeIfcTypeName(effectiveType),
      attrs: [...(created.attributes ?? [])],
      globalId: asString(created.attributes?.[0]) ?? '',
    } : undefined;
    const viewed = view?.readEntity?.(id, effectiveType, source);
    if (!viewed) return source;
    const type = normalizeIfcTypeName(viewed.type); // a view may hand back STEP casing
    return type === viewed.type ? viewed : { ...viewed, type };
  };
  const activeByRole = new Map<StructuralRole, number[]>();
  const relMemberIds: number[] = [];
  const relPhysicalIds: number[] = [];
  const relActivityIds: number[] = [];
  const relGroupIds: number[] = [];
  for (const row of effectiveRows) {
    const role = roleOf(row.type);
    if (role) {
      const ids = activeByRole.get(role) ?? [];
      ids.push(row.expressId);
      activeByRole.set(role, ids);
    }
    if (MEMBER_RELATION_TYPES.includes(row.type)) relMemberIds.push(row.expressId);
    if (PHYSICAL_LINK_TYPES.includes(row.type)) relPhysicalIds.push(row.expressId);
    if (row.type === 'IFCRELCONNECTSSTRUCTURALACTIVITY') relActivityIds.push(row.expressId);
    if (row.type === 'IFCRELASSIGNSTOGROUP') relGroupIds.push(row.expressId);
  }
  const readRows = (ids: readonly number[]): RawEntity[] =>
    ids.map((id) => readRaw(id, effectiveTypeById.get(id)!)).filter((row): row is RawEntity => !!row);
  const read = (role: StructuralRole): RawEntity[] => readRows(activeByRole.get(role) ?? []);
  const typeOf = (id: number): string => effectiveTypeById.get(id) ?? typeMutations?.get(id)?.newType
    ?? getEntityRefFromStore(store, id)?.type ?? exactTypeName(store.entities, id);
  const isDeleted = (id: number): boolean => view?.isDeleted(id) ?? false;
  const readResolved = (id: number) => (isDeleted(id) ? undefined : readRaw(id, typeOf(id)));
  /** Deleted resources read as absent; loads and conditions use the view only when one exists. */
  const viewResource = view ? readResolved : undefined;

  const memberRaw = read('member');
  const connectionRaw = read('connection');
  const activityRaw = read('activity');
  const loadGroupRaw = read('loadGroup');
  const resultGroupRaw = read('resultGroup');
  const analysisModelRaw = read('analysisModel');

  /** expressId → globalId, over every structural entity we resolved. */
  const globalIdById = new Map<number, string>();
  for (const list of [
    memberRaw,
    connectionRaw,
    activityRaw,
    loadGroupRaw,
    resultGroupRaw,
    analysisModelRaw,
  ]) {
    for (const e of list) if (e.globalId) globalIdById.set(e.expressId, e.globalId);
  }

  // ── Relationship passes ────────────────────────────────────────────────
  const boundaryCondition = (id: number) => extractBoundaryCondition(extractor, store, id, viewResource);
  const relationContext: StructuralRelationContext = { schema: store.schemaVersion, readResource: readResolved, typeOf, isDeleted, boundaryCondition };
  const connectionIds = new Set(connectionRaw.map((e) => e.expressId));
  const itemIds = new Set([...memberRaw.map((e) => e.expressId), ...connectionIds]);
  const physicalOfItem = readPhysicalLinks(readRows(relPhysicalIds), itemIds, relationContext);
  const memberRelationRows = readRows(relMemberIds);
  const memberRelations = readMemberRelations(memberRelationRows, connectionIds, relationContext);
  const connectionsOfMember = new Map<number, string[]>();
  const membersOfConnection = new Map<number, string[]>();
  for (const rel of memberRelationRows) {
    const memberId = asRef(readAttr(rel.type, rel.attrs, 'RelatingStructuralMember'));
    const connectionId = asRef(readAttr(rel.type, rel.attrs, 'RelatedStructuralConnection'));
    if (memberId === undefined || connectionId === undefined) continue;
    const memberGid = globalIdById.get(memberId);
    const connectionGid = globalIdById.get(connectionId);
    if (connectionGid) addUnique(connectionsOfMember, memberId, connectionGid);
    if (memberGid) addUnique(membersOfConnection, connectionId, memberGid);
  }

  const activitiesOfItem = new Map<number, string[]>();
  /** activity expressId → the item globalId it applies to. */
  const itemOfActivity = new Map<number, string>();
  for (const rel of readRows(relActivityIds)) {
    const itemId = asRef(readAttr(rel.type, rel.attrs, 'RelatingElement'));
    const activityId = asRef(readAttr(rel.type, rel.attrs, 'RelatedStructuralActivity'));
    if (itemId === undefined || activityId === undefined) continue;
    const activityGid = globalIdById.get(activityId);
    const itemGid = globalIdById.get(itemId);
    if (activityGid) addUnique(activitiesOfItem, itemId, activityGid);
    if (itemGid) itemOfActivity.set(activityId, itemGid);
  }

  // IfcRelAssignsToGroup is shared with every other grouping in the file, so
  // only the rows whose RelatingGroup is a structural group are read.
  const groupsOfObject = new Map<number, string[]>();
  const objectsOfGroup = new Map<number, string[]>();
  for (const rel of readRows(relGroupIds)) {
    const groupId = asRef(readAttr(rel.type, rel.attrs, 'RelatingGroup'));
    if (groupId === undefined) continue;
    const groupGid = globalIdById.get(groupId);
    if (!groupGid) continue;
    for (const objectId of asRefList(readAttr(rel.type, rel.attrs, 'RelatedObjects'))) {
      addUnique(groupsOfObject, objectId, groupGid);
      const objectGid = globalIdById.get(objectId);
      if (objectGid) addUnique(objectsOfGroup, groupId, objectGid);
    }
  }

  /**
   * A group's `RelatedObjects` may hold anything, and IfcRelAssignsToGroup is
   * not structural-specific, so each of the three directions below is narrowed
   * to the role its field name promises rather than reporting the raw set.
   */
  const gidsOf = (lists: RawEntity[][]): Set<string> =>
    new Set(lists.flat().map((e) => e.globalId).filter((g) => g.length > 0));

  const analysisModelGids = gidsOf([analysisModelRaw]);
  const activityGids = gidsOf([activityRaw]);
  const itemGids = gidsOf([memberRaw, connectionRaw]);

  /** Only those of `expressId`'s groups that are analysis models. */
  const modelsOf = (expressId: number): string[] =>
    (groupsOfObject.get(expressId) ?? []).filter((g) => analysisModelGids.has(g));
  /** Only the activities assigned into the group `expressId`. */
  const activitiesIn = (expressId: number): string[] =>
    (objectsOfGroup.get(expressId) ?? []).filter((g) => activityGids.has(g));
  /** Only the members and connections assigned into the group `expressId`. */
  const itemsIn = (expressId: number): string[] =>
    (objectsOfGroup.get(expressId) ?? []).filter((g) => itemGids.has(g));

  const resolveGids = (value: unknown): string[] =>
    asRefList(value)
      .map((id) => globalIdById.get(id))
      .filter((g): g is string => g !== undefined);

  // ── Assemble ───────────────────────────────────────────────────────────
  const members: StructuralMemberInfo[] = memberRaw.map((e) => ({
    expressId: e.expressId,
    globalId: e.globalId,
    type: e.type,
    ...rootFields(e),
    predefinedType: asEnum(readAttr(e.type, e.attrs, 'PredefinedType')),
    Axis: asRef(readAttr(e.type, e.attrs, 'Axis')),
    physicalElementIds: physicalOfItem.get(e.expressId) ?? [],
    IfcRelConnectsStructuralMember: memberRelations.get(e.expressId) ?? [],
    thickness: asNumber(readAttr(e.type, e.attrs, 'Thickness')),
    connectionGlobalIds: connectionsOfMember.get(e.expressId) ?? [],
    activityGlobalIds: activitiesOfItem.get(e.expressId) ?? [],
    analysisModelGlobalIds: modelsOf(e.expressId),
  }));

  const connections: StructuralConnectionInfo[] = connectionRaw.map((e) => {
    const conditionId = asRef(readAttr(e.type, e.attrs, 'AppliedCondition'));
    return {
      expressId: e.expressId,
      globalId: e.globalId,
      type: e.type,
      ...rootFields(e),
      Axis: asRef(readAttr(e.type, e.attrs, 'Axis')),
      AxisDirection: asRef(readAttr(e.type, e.attrs, 'AxisDirection')),
      ConditionCoordinateSystem: asRef(readAttr(e.type, e.attrs, 'ConditionCoordinateSystem')),
      physicalElementIds: physicalOfItem.get(e.expressId) ?? [],
      appliedCondition:
        conditionId === undefined
          ? undefined
          : boundaryCondition(conditionId),
      memberGlobalIds: membersOfConnection.get(e.expressId) ?? [],
      activityGlobalIds: activitiesOfItem.get(e.expressId) ?? [],
      analysisModelGlobalIds: modelsOf(e.expressId),
    };
  });

  const activities: StructuralActivityInfo[] = activityRaw.map((e) => {
    const loadId = asRef(readAttr(e.type, e.attrs, 'AppliedLoad'));
    return {
      expressId: e.expressId,
      globalId: e.globalId,
      type: e.type,
      kind: activityKind(e.type),
      ...rootFields(e),
      predefinedType: asEnum(readAttr(e.type, e.attrs, 'PredefinedType')),
      ProjectedOrTrue: asEnum(readAttr(e.type, e.attrs, 'ProjectedOrTrue')),
      globalOrLocal: asEnum(readAttr(e.type, e.attrs, 'GlobalOrLocal')),
      destabilizingLoad: asBoolean(readAttr(e.type, e.attrs, 'DestabilizingLoad')),
      appliedLoad:
        loadId === undefined ? undefined : extractStructuralLoad(extractor, store, loadId, viewResource),
      appliesToGlobalId: itemOfActivity.get(e.expressId),
      groupGlobalIds: groupsOfObject.get(e.expressId) ?? [],
    };
  });

  const loadGroups: StructuralLoadGroupInfo[] = loadGroupRaw.map((e) => ({
    expressId: e.expressId,
    globalId: e.globalId,
    type: e.type,
    ...rootFields(e),
    predefinedType: asEnum(readAttr(e.type, e.attrs, 'PredefinedType')),
    actionType: asEnum(readAttr(e.type, e.attrs, 'ActionType')),
    actionSource: asEnum(readAttr(e.type, e.attrs, 'ActionSource')),
    coefficient: asNumber(readAttr(e.type, e.attrs, 'Coefficient')),
    purpose: asString(readAttr(e.type, e.attrs, 'Purpose')),
    selfWeightCoefficients: asNumberList(readAttr(e.type, e.attrs, 'SelfWeightCoefficients')),
    activityGlobalIds: activitiesIn(e.expressId),
  }));

  const resultGroups: StructuralResultGroupInfo[] = resultGroupRaw.map((e) => {
    const forLoadGroup = asRef(readAttr(e.type, e.attrs, 'ResultForLoadGroup'));
    return {
      expressId: e.expressId,
      globalId: e.globalId,
      ...rootFields(e),
      theoryType: asEnum(readAttr(e.type, e.attrs, 'TheoryType')),
      isLinear: asBoolean(readAttr(e.type, e.attrs, 'IsLinear')),
      resultForLoadGroupGlobalId:
        forLoadGroup === undefined ? undefined : globalIdById.get(forLoadGroup),
      activityGlobalIds: activitiesIn(e.expressId),
    };
  });

  const analysisModels: StructuralAnalysisModelInfo[] = analysisModelRaw.map((e) => ({
    expressId: e.expressId,
    globalId: e.globalId,
    ...rootFields(e),
    predefinedType: asEnum(readAttr(e.type, e.attrs, 'PredefinedType')),
    loadGroupGlobalIds: resolveGids(readAttr(e.type, e.attrs, 'LoadedBy')),
    resultGroupGlobalIds: resolveGids(readAttr(e.type, e.attrs, 'HasResults')),
    itemGlobalIds: itemsIn(e.expressId),
  }));

  return {
    analysisModels,
    members,
    connections,
    activities,
    loadGroups,
    resultGroups,
    hasStructural:
      analysisModels.length +
        members.length +
        connections.length +
        activities.length +
        loadGroups.length +
        resultGroups.length >
      0,
    // Derived from the loads rather than tracked alongside them, so the
    // extraction cannot claim a completeness its own tree contradicts. A
    // nested configuration propagates its truncation to its parent, so the
    // top-level load carries the whole subtree's answer.
    loadsTruncated: activities.some((a) => a.appliedLoad?.configuration?.truncated === true),
  };
}
