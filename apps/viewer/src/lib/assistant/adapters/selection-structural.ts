/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getAttributeTypeForSchema, measureUnit, type ProjectUnits, type StructuralExtraction, type StructuralLoadInfo,
  type BoundaryConditionInfo } from '@ifc-lite/parser';
import { selectedStructuralMember, structuralRecord, structuralRelatedRows } from '@/components/viewer/properties/selectedStructuralMember';
const bounded = (value: string | undefined) => value === undefined || value === '' ? null : value.length > 240 ? `${value.slice(0, 240)}…` : value;
function components(record: StructuralLoadInfo | BoundaryConditionInfo, limit: number, units: ProjectUnits, schema: string | undefined) {
  const all = Object.entries(record.components);
  const sample = all.slice(0, limit);
  return { componentCount: all.length, components: Object.fromEntries(sample),
    componentUnits: Object.fromEntries(sample.map(([name]) => {
      const type = getAttributeTypeForSchema(record.type, name, schema);
      const measure = type ? measureUnit(type) : undefined;
      // Declared source units only. A boolean support never invents a stiffness unit.
      const unit = measure && 'unitType' in measure ? units.resolvedForUnitType(measure.unitType)?.symbol : undefined;
      return [name, unit ?? null];
    })) };
}
function loadEvidence(load: StructuralLoadInfo, limit: number, units: ProjectUnits, schema: string | undefined) {
  const pending = [{ load, path: [] as number[] }];
  const configurations = [];
  let consumed = 0;
  let nativeTruncated = false;
  let evidenceTruncated = false;
  // Iterative and globally budgeted; repeated native slots remain distinct by path.
  while (pending.length > 0 && consumed < 64) {
    const current = pending.shift()!; consumed++;
    const configuration = current.load.configuration;
    if (!configuration) continue;
    nativeTruncated ||= configuration.truncated;
    const entries = configuration.entries.slice(0, limit).map((entry, index) => {
      const path = [...current.path, index];
      if (entry.value?.configuration) pending.push({ load: entry.value, path });
      return { index, dropped: entry.dropped ?? null, location: entry.location?.slice(0, 3) ?? null,
        value: entry.value ? { expressId: entry.value.expressId, type: entry.value.type, Name: bounded(entry.value.name),
          ...components(entry.value, limit, units, schema), configurationPath: entry.value.configuration ? path : null } : null };
    });
    if (entries.length < configuration.entries.length) evidenceTruncated = true;
    configurations.push({ path: current.path, entryCount: configuration.entries.length, entries,
      nativeTruncated: configuration.truncated, omittedEntries: configuration.entries.length - entries.length });
  }
  evidenceTruncated ||= pending.length > 0;
  return { expressId: load.expressId, type: load.type, Name: bounded(load.name), ...components(load, limit, units, schema),
    configurations, nativeTruncated, evidenceTruncated, configurationNodeBudget: 64 };
}

type Connection = StructuralExtraction['connections'][number];
type Activity = StructuralExtraction['activities'][number];
type AnalysisModel = StructuralExtraction['analysisModels'][number];

const connectionRow = (connection: Connection, valueLimit: number, units: ProjectUnits, schema: string | undefined) => ({ expressId: connection.expressId,
  type: connection.type, GlobalId: bounded(connection.globalId), Name: bounded(connection.name), AppliedCondition: connection.appliedCondition ? {
    expressId: connection.appliedCondition.expressId, type: connection.appliedCondition.type, Name: bounded(connection.appliedCondition.name),
    ...components(connection.appliedCondition, valueLimit, units, schema) } : null });
const activityRow = (activity: Activity, valueLimit: number, units: ProjectUnits, schema: string | undefined) => ({ expressId: activity.expressId,
  type: activity.type, GlobalId: bounded(activity.globalId), Name: bounded(activity.name), GlobalOrLocal: bounded(activity.globalOrLocal),
  DestabilizingLoad: activity.destabilizingLoad ?? null, AppliedLoad: activity.appliedLoad ? loadEvidence(activity.appliedLoad, valueLimit, units, schema) : null });
const modelRow = (model: AnalysisModel, limit: number, count: (value: number) => number | null) => ({ expressId: model.expressId,
  GlobalId: bounded(model.globalId), Name: bounded(model.name), PredefinedType: bounded(model.predefinedType), loadGroupCount: count(model.loadGroupGlobalIds.length),
  resultGroupCount: count(model.resultGroupGlobalIds.length), loadGroupGlobalIds: model.loadGroupGlobalIds.slice(0, limit), resultGroupGlobalIds: model.resultGroupGlobalIds.slice(0, limit) });

/** The scalar fields of a load group, load case, combination or result group, bounded; held records and large lists are not expanded. */
function groupRow(record: { type: string; info: object }, valueLimit: number, sourceAvailable: boolean) {
  const info = record.info as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(info)) {
    if (key === 'expressId' || key === 'type' || value === undefined || value === null) continue;
    if (typeof value === 'string') fields[key] = bounded(value);
    else if (typeof value === 'number' || typeof value === 'boolean') fields[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
      // Assignments are read from the source file; without it an empty list is unknown, not zero.
      fields[key] = { count: key.endsWith('GlobalIds') && !sourceAvailable ? null : value.length, values: value.slice(0, valueLimit) };
    }
  }
  return { expressId: info.expressId, type: record.type, ...fields };
}

/** The native StructuralCard content: member evidence for a member, else the record itself for any other structural record (connection, action, reaction, load group or case, result group, analysis model). */
export function structuralEvidence(data: StructuralExtraction | null, expressId: number, globalId: string | undefined,
  limit: number, valueLimit: number, units: ProjectUnits, schema: string | undefined, sourceAvailable: boolean) {
  const member = selectedStructuralMember(data, expressId, globalId);
  if (!data) return null;
  if (!member) {
    const found = structuralRecord(data, expressId, globalId);
    if (!found) return null;
    const info = found.info;
    const count = (value: number) => sourceAvailable ? value : null;
    const row = found.type === 'IfcStructuralAnalysisModel' ? { type: found.type, ...modelRow(info as AnalysisModel, limit, count) }
      : data.activities.includes(info as Activity) ? activityRow(info as Activity, valueLimit, units, schema)
      : data.connections.includes(info as Connection) ? connectionRow(info as Connection, valueLimit, units, schema)
      : groupRow(found, valueLimit, sourceAvailable);
    return { record: row };
  }
  const connectionRows = structuralRelatedRows(data.connections, member.connectionGlobalIds);
  const activityRows = structuralRelatedRows(data.activities, member.activityGlobalIds);
  const modelRows = structuralRelatedRows(data.analysisModels, member.analysisModelGlobalIds);
  const connections = connectionRows.rows;
  const activities = activityRows.rows;
  const models = modelRows.rows;
  const count = (value: number, unavailable = false) => sourceAvailable && !unavailable ? value : null;
  return { member: { expressId: member.expressId, type: member.type, GlobalId: bounded(member.globalId), Name: bounded(member.name),
    Description: bounded(member.description), ObjectType: bounded(member.objectType), PredefinedType: bounded(member.predefinedType),
    Thickness: member.thickness ?? null, thicknessUnit: units.resolvedForUnitType('LENGTHUNIT')?.symbol ?? null },
    nativeResolvedConnectionCount: count(connections.length, connectionRows.unavailable), nativeResolvedActivityCount: count(activities.length, activityRows.unavailable), nativeResolvedAnalysisModelCount: count(models.length, modelRows.unavailable),
    relationshipTargetsUnavailable: connectionRows.unavailable || activityRows.unavailable || modelRows.unavailable,
    modelNativeLoadsTruncated: data.loadsTruncated,
    connections: connections.slice(0, limit).map(connection => connectionRow(connection, valueLimit, units, schema)),
    activities: activities.slice(0, limit).map(activity => activityRow(activity, valueLimit, units, schema)),
    analysisModels: models.slice(0, limit).map(model => modelRow(model, limit, count)) };
}
