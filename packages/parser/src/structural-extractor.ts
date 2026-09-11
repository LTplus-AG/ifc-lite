/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Structural analysis extractor — parses IfcStructuralAnalysisModel,
 * IfcStructuralMember / IfcStructuralConnection subtypes, IfcStructuralAction /
 * IfcStructuralReaction subtypes, IfcStructuralLoadGroup / IfcStructuralLoadCase,
 * IfcStructuralResultGroup, IfcBoundaryCondition, IfcRelConnectsStructuralMember,
 * IfcRelConnectsStructuralActivity and IfcRelAssignsToGroup from a parsed
 * IfcDataStore into a connected `StructuralExtraction`.
 *
 * On-demand, like the schedule extractor: nothing here runs during a normal
 * parse, and a model with no structural entity costs one `byType` sweep.
 *
 * The two structural connects-relationships are read from the type index
 * directly rather than from the relationship graph, because that graph's
 * `REL_TYPE_MAP` carries neither of them — the rows are retained, but nothing
 * indexes member↔connection or item↔activity edges for a query traversal to
 * follow.
 *
 * Two things are schema-derived rather than hand-tabulated, because the
 * alternative is a table that silently mis-reads the next subtype to appear:
 *
 * - **Which types count.** Every `IFCSTRUCTURAL*` key in the type index is
 *   classified by its inheritance chain, so `IfcStructuralCurveMemberVarying`
 *   is a member and `IfcStructuralLinearAction` is an action without either
 *   being named here.
 * - **Where each attribute sits.** Positions come from the generated registry
 *   by EXPRESS attribute name, never from a literal index.
 *
 * IFC2X3 support is best-effort and the divergences are known, not assumed:
 * 2X3 has no IfcStructuralCurveAction, IfcStructuralSurfaceAction,
 * IfcStructuralCurveReaction, IfcStructuralLoadCase or
 * IfcStructuralLoadConfiguration at all, and its IfcStructuralCurveMember has
 * no `Axis`. Positions resolve against the parser's IFC4 registry pin, which
 * agrees with 2X3 on the attributes both schemas share for every type read
 * here; a 2X3-only attribute reads as absent rather than as the wrong slot.
 */

import { EntityExtractor } from './entity-extractor.js';
import type { IfcDataStore } from './columnar-parser.js';
import { getInheritanceChain } from './ifc-schema.js';
import {
  extractBoundaryCondition,
  extractStructuralLoad,
  type BoundaryConditionInfo,
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
  readAttr,
  readEntities,
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

export type {
  BoundaryConditionInfo,
  StructuralActivityInfo,
  StructuralAnalysisModelInfo,
  StructuralConnectionInfo,
  StructuralExtraction,
  StructuralLoadGroupInfo,
  StructuralLoadInfo,
  StructuralMemberInfo,
  StructuralResultGroupInfo,
};

function emptyExtraction(): StructuralExtraction {
  return {
    analysisModels: [],
    members: [],
    connections: [],
    activities: [],
    loadGroups: [],
    resultGroups: [],
    hasStructural: false,
  };
}

type StructuralRole =
  | 'member'
  | 'connection'
  | 'activity'
  | 'loadGroup'
  | 'resultGroup'
  | 'analysisModel';

/** Chain marker → role. Every marker is disjoint, so match order is not load-bearing. */
const ROLE_BY_SUPERTYPE: ReadonlyArray<readonly [string, StructuralRole]> = [
  ['IFCSTRUCTURALANALYSISMODEL', 'analysisModel'],
  ['IFCSTRUCTURALRESULTGROUP', 'resultGroup'],
  ['IFCSTRUCTURALLOADGROUP', 'loadGroup'],
  ['IFCSTRUCTURALMEMBER', 'member'],
  ['IFCSTRUCTURALCONNECTION', 'connection'],
  ['IFCSTRUCTURALACTIVITY', 'activity'],
];

/**
 * Classify a concrete type by inheritance, not by name. Returns undefined for
 * an `IFCSTRUCTURAL*` type that is none of the six roles — `IfcStructuralLoad`
 * leaves and `IfcStructuralProfileProperties` reach here and are read through
 * their owners instead.
 */
function roleOf(type: string): StructuralRole | undefined {
  const chain = getInheritanceChain(type).map((c) => c.toUpperCase());
  for (const [marker, role] of ROLE_BY_SUPERTYPE) {
    if (chain.includes(marker)) return role;
  }
  return undefined;
}

function activityKind(type: string): 'Action' | 'Reaction' | 'Unknown' {
  const chain = getInheritanceChain(type).map((c) => c.toUpperCase());
  if (chain.includes('IFCSTRUCTURALACTION')) return 'Action';
  if (chain.includes('IFCSTRUCTURALREACTION')) return 'Reaction';
  return 'Unknown';
}

/** IfcRoot attribute 2 is Name, 3 Description; IfcObject adds ObjectType at 4. */
function rootFields(e: RawEntity): {
  name?: string;
  description?: string;
  objectType?: string;
} {
  return {
    name: asString(e.attrs[2]),
    description: asString(e.attrs[3]),
    objectType: asString(e.attrs[4]),
  };
}

/**
 * Extract all structural analysis data from a parsed IFC store.
 */
export function extractStructuralOnDemand(store: IfcDataStore): StructuralExtraction {
  if (!store.source?.length) return emptyExtraction();

  const byType = store.entityIndex.byType;

  // Partition every IFCSTRUCTURAL* type present into the six roles.
  const idsByRole = new Map<StructuralRole, number[]>();
  for (const [typeKey, ids] of byType) {
    if (!typeKey.startsWith('IFCSTRUCTURAL')) continue;
    const role = roleOf(typeKey);
    if (!role) continue;
    const bucket = idsByRole.get(role);
    if (bucket) bucket.push(...ids);
    else idsByRole.set(role, [...ids]);
  }

  const relMemberIds = byType.get('IFCRELCONNECTSSTRUCTURALMEMBER') ?? [];
  const relActivityIds = byType.get('IFCRELCONNECTSSTRUCTURALACTIVITY') ?? [];
  const relGroupIds = byType.get('IFCRELASSIGNSTOGROUP') ?? [];

  // Behaviour-neutral early-out, not a guard: with no structural entity the
  // passes below already produce an empty extraction. It exists so the common
  // case — a model with no structural analysis at all — never constructs an
  // EntityExtractor over the whole source buffer.
  if (idsByRole.size === 0) return emptyExtraction();

  const extractor = new EntityExtractor(store.source);
  const read = (role: StructuralRole): RawEntity[] =>
    readEntities(extractor, store, idsByRole.get(role) ?? []);

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
  const connectionsOfMember = new Map<number, string[]>();
  const membersOfConnection = new Map<number, string[]>();
  for (const rel of readEntities(extractor, store, relMemberIds)) {
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
  for (const rel of readEntities(extractor, store, relActivityIds)) {
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
  for (const rel of readEntities(extractor, store, relGroupIds)) {
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
      appliedCondition:
        conditionId === undefined
          ? undefined
          : extractBoundaryCondition(extractor, store, conditionId),
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
      globalOrLocal: asEnum(readAttr(e.type, e.attrs, 'GlobalOrLocal')),
      destabilizingLoad: asBoolean(readAttr(e.type, e.attrs, 'DestabilizingLoad')),
      appliedLoad:
        loadId === undefined ? undefined : extractStructuralLoad(extractor, store, loadId),
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
  };
}
