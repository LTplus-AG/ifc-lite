/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { ownedAggregationRelationships } from '@/utils/aggregation-ownership';
import type { FederatedModel } from '@/store';
import { effectiveGroupAssignments, effectiveGroupIds, effectiveGroupMembers, effectiveGroupName } from './effectiveGroupEntities.js';
import { GROUP_ENTITY_TYPES, groupMatchesSubFilter, type GroupSubFilter } from './groupEntityTypes.js';
import { overlayViewFor, type TreeOverlay } from './treeOverlay.js';
import { resolveTreeGlobalId } from './productTree.js';
import type { TreeNode, ExpansionLookup } from './types.js';

const groupNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** A geometry-bearing entity a group member resolves to. */
export interface ResolvedMemberGeometry {
  expressId: number;
  globalId: number;
}

/**
 * Resolve a group member to the geometry that should represent it (#1622).
 * IfcRelAssignsToGroup members are frequently geometry-less: in HVAC exports
 * roughly two thirds of an IfcDistributionSystem's members are
 * IfcDistributionPorts, so raw isolation would render a perforated (or empty)
 * network. If the member itself carries geometry, that's the answer; otherwise
 * fold in its IfcRelNests/IfcRelAggregates relatives — IfcRelNests is mapped
 * onto the shared Aggregates edge bucket (see columnar-parser-indexes), so
 * `inverse` yields a port's nesting host element and `forward` yields nested /
 * aggregated children — keeping only relatives that actually have geometry.
 * Nested groups are traversed separately by buildGroupTree (#7870).
 */
export function resolveMemberGeometry(
  dataStore: IfcDataStore,
  memberExpressId: number,
  toGlobal: (expressId: number) => number,
  geometricIds: Set<number>,
  view?: MutablePropertyView | null,
): ResolvedMemberGeometry[] {
  const ownGlobal = toGlobal(memberExpressId);
  if (geometricIds.has(ownGlobal)) {
    return [{ expressId: memberExpressId, globalId: ownGlobal }];
  }
  const relationships = ownedAggregationRelationships(dataStore, view);
  if (!relationships) return [];
  const out: ResolvedMemberGeometry[] = [];
  const seen = new Set<number>();
  for (const direction of ['inverse', 'forward'] as const) {
    for (const relatedId of relationships.getRelated(memberExpressId, RelationshipType.Aggregates, direction)) {
      if (relatedId === memberExpressId || seen.has(relatedId)) continue;
      seen.add(relatedId);
      const globalId = toGlobal(relatedId);
      if (geometricIds.has(globalId)) {
        out.push({ expressId: relatedId, globalId });
      }
    }
  }
  return out;
}

/**
 * Build the Groups DAG as a tree of occurrences (#1622, #7870). Nested groups
 * are structural; shared groups and members appear under each parent. Geometry
 * is unioned through all group edges, independently of expansion and filtering.
 */
export function buildGroupTree(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  expandedNodes: ExpansionLookup,
  _isMultiModel: boolean,
  geometricIds?: Set<number>,
  subFilter: GroupSubFilter = 'all',
  overlay?: TreeOverlay,
): TreeNode[] {
  interface MemberRow {
    expressId: number;
    globalId: number;
    name: string;
    ifcType: string;
  }
  interface GroupEntry {
    modelId: string;
    groupExpressId: number;
    name: string;
    ifcType: string;
    typeRank: number;
    memberRows: MemberRow[];
    memberGlobalIds: number[];
    memberExpressIds: number[];
    isolationGlobalIds: number[];
    children: GroupEntry[];
    parents: GroupEntry[];
  }

  const geo = geometricIds ?? new Set<number>();
  const entries: GroupEntry[] = [];

  const processDataStore = (dataStore: IfcDataStore, modelId: string) => {
    const entities = dataStore.entities;
    if (!entities) return;
    const toGlobal = (expressId: number) => resolveTreeGlobalId(modelId, expressId, models);
    const view = overlayViewFor(overlay, modelId);
    const groups = effectiveGroupIds(dataStore, view);
    const assignments = effectiveGroupAssignments(dataStore, view);
    const allGroupIds = new Set([...groups.values()].flat());

    const storeEntries = new Map<number, GroupEntry>();
    for (let rank = 0; rank < GROUP_ENTITY_TYPES.length; rank++) {
      const typeName = GROUP_ENTITY_TYPES[rank];
      const groupIds = groups.get(typeName);
      if (!groupIds || groupIds.length === 0) continue;

      for (const groupId of groupIds) {
        const members = effectiveGroupMembers(dataStore, groupId, view, assignments);
        // Empty group: a dead click, skip (mirror the empty-material skip).
        if (members.length === 0) continue;

        const rowByGlobalId = new Map<number, MemberRow>();
        const isolation = new Set<number>();
        for (const member of members) {
          const ownGlobal = toGlobal(member.id);
          const resolved = resolveMemberGeometry(dataStore, member.id, toGlobal, geo, view);
          for (const r of resolved) isolation.add(r.globalId);

          if (allGroupIds.has(member.id) || (resolved.length === 1 && resolved[0].expressId === member.id)) {
            // Structural groups keep their identity even if they carry geometry.
            if (!rowByGlobalId.has(ownGlobal)) {
              rowByGlobalId.set(ownGlobal, {
                expressId: member.id,
                globalId: ownGlobal,
                name: member.name || `${member.type} #${member.id}`,
                ifcType: member.type,
              });
            }
          } else if (resolved.length > 0) {
            // Geometry-less member (port): list its geometry-bearing relatives
            // instead of a dead row. The host element is often ALSO a direct
            // member — the by-globalId map collapses those to one row.
            for (const r of resolved) {
              if (rowByGlobalId.has(r.globalId)) continue;
              const relName = entities.getName(r.expressId);
              const relType = entities.getTypeName(r.expressId) || 'Unknown';
              rowByGlobalId.set(r.globalId, {
                expressId: r.expressId,
                globalId: r.globalId,
                name: relName || `${relType} #${r.expressId}`,
                ifcType: relType,
              });
            }
          } else if (!rowByGlobalId.has(ownGlobal)) {
            // No geometry anywhere (nested group/zone, proxy without shape):
            // keep a select-only row so the membership stays browsable.
            rowByGlobalId.set(ownGlobal, {
              expressId: member.id,
              globalId: ownGlobal,
              name: member.name || `${member.type} #${member.id}`,
              ifcType: member.type,
            });
          }
        }

        // Name with ObjectType fallback for unnamed systems — same display
        // logic as the properties panel's Groups & Zones card (#1075).
        storeEntries.set(groupId, {
          modelId,
          groupExpressId: groupId,
          name: effectiveGroupName(dataStore, view, groupId, typeName),
          ifcType: typeName,
          typeRank: rank,
          memberRows: Array.from(rowByGlobalId.values()),
          memberGlobalIds: members.map((member) => toGlobal(member.id)),
          memberExpressIds: members.map((member) => member.id),
          isolationGlobalIds: Array.from(isolation),
          children: [],
          parents: [],
        });
      }
    }
    for (const entry of storeEntries.values()) {
      for (const id of entry.memberExpressIds) {
        const child = storeEntries.get(id);
        if (!child) continue;
        entry.children.push(child);
        child.parents.push(entry);
      }
      entries.push(entry);
    }
  };

  if (models.size > 0) {
    // Federated IFCX layers all share ONE composed data store (each overlay
    // is registered as a "model" for the Models panel) — process each
    // distinct store once or every group row would repeat per layer.
    const processed = new Set<IfcDataStore>();
    for (const [modelId, model] of models) {
      const store = model.ifcDataStore;
      if (!store || processed.has(store)) continue;
      processed.add(store);
      processDataStore(store, modelId);
    }
  } else if (ifcDataStore) {
    processDataStore(ifcDataStore, 'legacy');
  }

  // Propagate each newly discovered geometry id to parents once. This fixed
  // point handles cycles without recursion or repeatedly walking deep chains.
  const geometry = new Map(entries.map(entry => [entry, new Set(entry.isolationGlobalIds)]));
  const pending = entries.filter(entry => entry.isolationGlobalIds.length > 0);
  const queued = new Set(pending);
  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    queued.delete(entry);
    for (const parent of entry.parents) {
      const target = geometry.get(parent)!;
      const before = target.size;
      for (const id of geometry.get(entry)!) target.add(id);
      if (target.size !== before && !queued.has(parent)) {
        queued.add(parent);
        pending.push(parent);
      }
    }
  }
  for (const entry of entries) entry.isolationGlobalIds = [...geometry.get(entry)!];

  const compare = (a: GroupEntry, b: GroupEntry) =>
    a.typeRank - b.typeRank || groupNameCollator.compare(a.name, b.name);
  const visible = entries.filter(entry => groupMatchesSubFilter(entry.ifcType, subFilter)).sort(compare);
  const visibleSet = new Set(visible);
  const roots = visible.filter(entry => !entry.parents.some(parent => visibleSet.has(parent)));
  const reached = new Set<GroupEntry>();
  const cycleRoots = new Set<GroupEntry>();
  const markReachable = (root: GroupEntry) => {
    const stack = [root];
    while (stack.length) {
      const entry = stack.pop()!;
      cycleRoots.delete(entry);
      if (reached.has(entry)) continue;
      reached.add(entry);
      for (const child of entry.children) if (visibleSet.has(child)) stack.push(child);
    }
  };
  for (const root of roots) markReachable(root);
  // A component made entirely of cycles has no natural root. Keep it browsable
  // via one deterministic entry instead of silently losing every group.
  for (const entry of visible) {
    if (reached.has(entry)) continue;
    markReachable(entry);
    cycleRoots.add(entry);
  }

  for (const root of cycleRoots) roots.push(root);
  roots.sort(compare);

  const nodes: TreeNode[] = [];
  type Frame = { entry: GroupEntry; id: string; depth: number; exit?: boolean };
  type LeafFrame = Frame & { row: MemberRow };
  const stack: (Frame | LeafFrame)[] = roots.reverse().map(entry => ({
    entry, id: `group-${entry.modelId}-${entry.groupExpressId}`, depth: 0,
  }));
  const path = new Set<GroupEntry>();
  // Even an acyclic many-to-many graph can have exponentially many paths.
  // Bound the displayed projection and report truncation; geometry stays exact.
  const maxRows = 50_000;
  while (stack.length && nodes.length < maxRows) {
    const frame = stack.pop()!;
    const { entry, id: nodeId, depth, exit } = frame;
    if ('row' in frame) {
      const row = frame.row;
      nodes.push({
        id: nodeId, expressIds: [row.expressId], globalIds: [row.globalId],
        modelIds: [entry.modelId], modelId: entry.modelId,
        name: row.name, type: 'group-member', ifcType: row.ifcType,
        depth, hasChildren: false, isExpanded: false, isVisible: true,
      });
      continue;
    }
    if (exit) {
      path.delete(entry);
      continue;
    }
    const cycle = path.has(entry);
    const hasChildren = !cycle && entry.memberRows.length > 0;
    const isExpanded = hasChildren && expandedNodes.has(nodeId);
    nodes.push({
      id: nodeId,
      expressIds: [entry.groupExpressId],
      globalIds: entry.isolationGlobalIds,
      memberGlobalIds: entry.memberGlobalIds,
      entityExpressId: entry.groupExpressId,
      modelIds: [entry.modelId],
      modelId: entry.modelId,
      name: entry.name,
      type: 'group',
      ifcType: entry.ifcType,
      depth,
      hasChildren,
      isExpanded,
      isVisible: true,
      elementCount: entry.memberRows.length,
    });
    if (!isExpanded) continue;
    path.add(entry);
    stack.push({ entry, id: nodeId, depth, exit: true });
    const children = new Map(entry.children.map(child => [child.groupExpressId, child]));
    const rows = [...entry.memberRows].sort((a, b) => groupNameCollator.compare(a.name, b.name));
    // Put all occurrences on the same stack so output order remains depth-first.
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const child = children.get(row.expressId);
      const id = depth === 0
        ? `groupmember-${entry.modelId}-${entry.groupExpressId}-${row.expressId}`
        : `${nodeId}-${row.expressId}`;
      if (child && visibleSet.has(child)) {
        stack.push({ entry: child, id, depth: depth + 1 });
      } else {
        stack.push({ entry, id, depth: depth + 1, row });
      }
    }
  }
  if (stack.some(frame => !frame.exit)) console.warn('Groups tree truncated at 50,000 rows (#7870)');
  return nodes;
}

