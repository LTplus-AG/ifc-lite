/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Schema-aware, on-demand structural analysis read model. */

import { EntityExtractor } from './entity-extractor.js';
import { iterateEffectiveEntities, type EffectiveEntityOverlay } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { normalizeIfcTypeName, getAttributeNamesForSchema, getInheritanceChain } from './ifc-schema.js';
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
  type RawEntity,
} from './structural-step-values.js';
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

  // @raw-entity-enumeration-ok source buckets define the candidate domain; iterateEffectiveEntities below applies tombstones, creations and retypes
  const readAttr = (type: string, attrs: unknown[], name: string): unknown =>
    attrs[getAttributeNamesForSchema(type, store.schemaVersion).indexOf(name)];
  const byType = store.entityIndex.byType;

  const sourceIds = new Set<number>();
  for (const [typeKey, ids] of byType) {
    if (!typeKey.startsWith('IFCSTRUCTURAL')) continue;
    const role = roleOf(typeKey);
    if (!role) continue;
    for (const id of ids) sourceIds.add(id);
  }

  const relationIds = new Set<number>([
    ...(byType.get('IFCRELCONNECTSSTRUCTURALMEMBER') ?? []),
    ...(byType.get('IFCRELCONNECTSWITHECCENTRICITY') ?? []),
    ...(byType.get('IFCRELASSIGNSTOPRODUCT') ?? []),
    ...(byType.get('IFCRELCONNECTSSTRUCTURALELEMENT') ?? []),
    ...(byType.get('IFCRELCONNECTSSTRUCTURALACTIVITY') ?? []),
    ...(byType.get('IFCRELASSIGNSTOGROUP') ?? []),
  ]);
  for (const id of relationIds) sourceIds.add(id);
  for (const [id, mutation] of view?.getTypeMutations?.() ?? []) {
    if (roleOf(mutation.newType) || mutation.newType.toUpperCase().startsWith('IFCRELCONNECTSSTRUCTURAL') || ['IFCRELASSIGNSTOGROUP', 'IFCRELASSIGNSTOPRODUCT', 'IFCRELCONNECTSWITHECCENTRICITY'].includes(mutation.newType.toUpperCase())) {
      sourceIds.add(id);
    }
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
    return view?.readEntity?.(id, effectiveType, source) ?? source;
  };
  const activeByRole = new Map<StructuralRole, number[]>();
  const relMemberIds: number[] = [];
  const relActivityIds: number[] = [];
  const relGroupIds: number[] = [];
  for (const row of effectiveRows) {
    const role = roleOf(row.type);
    if (role) {
      const ids = activeByRole.get(role) ?? [];
      ids.push(row.expressId);
      activeByRole.set(role, ids);
    }
    if (['IFCRELCONNECTSSTRUCTURALMEMBER', 'IFCRELCONNECTSWITHECCENTRICITY'].includes(row.type)) relMemberIds.push(row.expressId);
    if (row.type === 'IFCRELCONNECTSSTRUCTURALACTIVITY') relActivityIds.push(row.expressId);
    if (row.type === 'IFCRELASSIGNSTOGROUP') relGroupIds.push(row.expressId);
  }
  const read = (role: StructuralRole): RawEntity[] =>
    (activeByRole.get(role) ?? []).map((id) => readRaw(id, effectiveTypeById.get(id)!)).filter((row): row is RawEntity => !!row);

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
  const physicalElementStructuralItemIds: Record<number, number[]> = {};
  const physicalOfItem = new Map<number, number[]>();
  const itemIds = new Set([...memberRaw, ...connectionRaw].map(e => e.expressId));
  // @raw-entity-enumeration-ok resolve a bounded referenced resource's source type when it has no columnar row
  const typeOf = (id: number): string => effectiveTypeById.get(id) ?? store.entityIndex.byId.get(id)?.type ?? store.deferredEntityIndex?.get(id)?.type ?? store.entities.getTypeName(id);
  const readResource = (id: number): RawEntity | undefined => readRaw(id, typeOf(id));
  const additionalCondition = (value: unknown) => {
    const id = asRef(value);
    const e = id === undefined ? undefined : readResource(id);
    if (!e || !getInheritanceChain(e.type).includes('IfcStructuralConnectionCondition')) return undefined;
    const components: Record<string, number> = {};
    for (const name of getAttributeNamesForSchema(e.type, store.schemaVersion)) {
      const n = asNumber(readAttr(e.type, e.attrs, name));
      if (n !== undefined) components[name] = n;
    }
    return { expressId: e.expressId, type: e.type, name: asString(readAttr(e.type, e.attrs, 'Name')), components };
  };
  for (const row of effectiveRows) {
    if (!['IFCRELASSIGNSTOPRODUCT', 'IFCRELCONNECTSSTRUCTURALELEMENT'].includes(row.type)) continue;
    const rel = readRaw(row.expressId, row.type);
    if (!rel) continue;
    const product = asRef(readAttr(rel.type, rel.attrs, row.type === 'IFCRELASSIGNSTOPRODUCT' ? 'RelatingProduct' : 'RelatingElement'));
    const objects = row.type === 'IFCRELASSIGNSTOPRODUCT' ? asRefList(readAttr(rel.type, rel.attrs, 'RelatedObjects')) : [asRef(readAttr(rel.type, rel.attrs, 'RelatedStructuralMember'))];
    if (product === undefined) continue;
    for (const object of objects) {
      if (object === undefined) continue;
      const [item, physical] = itemIds.has(product) ? [product, object] : [object, product];
      const chain = getInheritanceChain(typeOf(physical));
      if (!itemIds.has(item) || !chain.includes('IfcProduct') || chain.includes('IfcStructuralItem') || chain.includes('IfcStructuralActivity')) continue;
      const ids = physicalOfItem.get(item) ?? [];
      if (!ids.includes(physical)) ids.push(physical);
      physicalOfItem.set(item, ids);
      const reverse = physicalElementStructuralItemIds[physical] ??= [];
      if (!reverse.includes(item)) reverse.push(item);
    }
  }
  const memberRelations = new Map<number, NonNullable<StructuralMemberInfo['IfcRelConnectsStructuralMember']>>();
  const connectionsOfMember = new Map<number, string[]>();
  const membersOfConnection = new Map<number, string[]>();
  for (const rel of relMemberIds.map((id) => readRaw(id, effectiveTypeById.get(id)!)).filter((row): row is RawEntity => !!row)) {
    const memberId = asRef(readAttr(rel.type, rel.attrs, 'RelatingStructuralMember'));
    const connectionId = asRef(readAttr(rel.type, rel.attrs, 'RelatedStructuralConnection'));
    if (memberId === undefined || connectionId === undefined) continue;
    const constraintId = asRef(readAttr(rel.type, rel.attrs, 'ConnectionConstraint'));
    const constraint = constraintId === undefined ? undefined : readResource(constraintId);
    const fields = constraint?.type === 'IfcConnectionPointEccentricity' ? {
      expressId: constraint.expressId,
      EccentricityInX: asNumber(readAttr(constraint.type, constraint.attrs, 'EccentricityInX')),
      EccentricityInY: asNumber(readAttr(constraint.type, constraint.attrs, 'EccentricityInY')),
      EccentricityInZ: asNumber(readAttr(constraint.type, constraint.attrs, 'EccentricityInZ')),
      PointOnRelatingElement: asRef(readAttr(constraint.type, constraint.attrs, 'PointOnRelatingElement')),
      PointOnRelatedElement: asRef(readAttr(constraint.type, constraint.attrs, 'PointOnRelatedElement')),
    } : undefined;
    const relations = memberRelations.get(memberId) ?? [];
    relations.push({ expressId: rel.expressId, RelatedStructuralConnection: connectionId,
      AdditionalConditions: additionalCondition(readAttr(rel.type, rel.attrs, 'AdditionalConditions')),
      SupportedLength: asNumber(readAttr(rel.type, rel.attrs, 'SupportedLength')),
      ConditionCoordinateSystem: asRef(readAttr(rel.type, rel.attrs, 'ConditionCoordinateSystem')),
      ConnectionConstraint: fields });
    memberRelations.set(memberId, relations);
    const memberGid = globalIdById.get(memberId);
    const connectionGid = globalIdById.get(connectionId);
    if (connectionGid) addUnique(connectionsOfMember, memberId, connectionGid);
    if (memberGid) addUnique(membersOfConnection, connectionId, memberGid);
  }

  const activitiesOfItem = new Map<number, string[]>();
  /** activity expressId → the item globalId it applies to. */
  const itemOfActivity = new Map<number, string>();
  for (const rel of relActivityIds.map((id) => readRaw(id, 'IFCRELCONNECTSSTRUCTURALACTIVITY')).filter((row): row is RawEntity => !!row)) {
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
  for (const rel of relGroupIds.map((id) => readRaw(id, 'IFCRELASSIGNSTOGROUP')).filter((row): row is RawEntity => !!row)) {
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
      ConditionCoordinateSystem: asRef(readAttr(e.type, e.attrs, 'ConditionCoordinateSystem')),
      physicalElementIds: physicalOfItem.get(e.expressId) ?? [],
      appliedCondition:
        conditionId === undefined
          ? undefined
          : extractBoundaryCondition(extractor, store, conditionId, view ? id => readRaw(id, effectiveTypeById.get(id) ?? store.entities.getTypeName(id)) : undefined),
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
        loadId === undefined ? undefined : extractStructuralLoad(extractor, store, loadId, view ? id => readRaw(id, effectiveTypeById.get(id) ?? store.entities.getTypeName(id)) : undefined),
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
    physicalElementStructuralItemIds,
    hasStructural:
      analysisModels.length +
        members.length +
        connections.length +
        activities.length +
        loadGroups.length +
        resultGroups.length >
      0,
    loadsTruncated: activities.some((a) => a.appliedLoad?.configuration?.truncated === true),
  };
}
