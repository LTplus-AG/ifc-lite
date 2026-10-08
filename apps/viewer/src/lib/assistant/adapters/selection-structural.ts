/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getAttributeTypeForSchema, measureUnit, type ProjectUnits, type StructuralExtraction, type StructuralLoadInfo,
  type BoundaryConditionInfo } from '@ifc-lite/parser';
import { selectedStructuralMember } from '@/components/viewer/properties/selectedStructuralMember';
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

/** Only the existing native selected-member StructuralCard section, no new structural feature. */
export function structuralEvidence(data: StructuralExtraction | null, expressId: number, globalId: string | undefined,
  limit: number, valueLimit: number, units: ProjectUnits, schema: string | undefined, sourceAvailable: boolean) {
  const member = selectedStructuralMember(data, expressId, globalId);
  if (!member || !data) return null;
  const connections = data.connections.filter(connection => member.connectionGlobalIds.includes(connection.globalId));
  const activities = data.activities.filter(activity => member.activityGlobalIds.includes(activity.globalId));
  const models = data.analysisModels.filter(model => member.analysisModelGlobalIds.includes(model.globalId));
  const count = (value: number) => sourceAvailable ? value : null;
  return { member: { expressId: member.expressId, type: member.type, GlobalId: bounded(member.globalId), Name: bounded(member.name),
    Description: bounded(member.description), ObjectType: bounded(member.objectType), PredefinedType: bounded(member.predefinedType),
    Thickness: member.thickness ?? null, thicknessUnit: units.resolvedForUnitType('LENGTHUNIT')?.symbol ?? null },
    nativeResolvedConnectionCount: count(connections.length), nativeResolvedActivityCount: count(activities.length), nativeResolvedAnalysisModelCount: count(models.length),
    modelNativeLoadsTruncated: data.loadsTruncated,
    connections: connections.slice(0, limit).map(connection => ({ expressId: connection.expressId, type: connection.type,
      GlobalId: bounded(connection.globalId), Name: bounded(connection.name), AppliedCondition: connection.appliedCondition ? {
        expressId: connection.appliedCondition.expressId, type: connection.appliedCondition.type, Name: bounded(connection.appliedCondition.name),
        ...components(connection.appliedCondition, valueLimit, units, schema) } : null })),
    activities: activities.slice(0, limit).map(activity => ({ expressId: activity.expressId, type: activity.type, GlobalId: bounded(activity.globalId),
      Name: bounded(activity.name), GlobalOrLocal: bounded(activity.globalOrLocal), DestabilizingLoad: activity.destabilizingLoad ?? null,
      AppliedLoad: activity.appliedLoad ? loadEvidence(activity.appliedLoad, valueLimit, units, schema) : null })),
    analysisModels: models.slice(0, limit).map(model => ({ expressId: model.expressId, GlobalId: bounded(model.globalId), Name: bounded(model.name),
      PredefinedType: bounded(model.predefinedType), loadGroupCount: count(model.loadGroupGlobalIds.length), resultGroupCount: count(model.resultGroupGlobalIds.length),
      loadGroupGlobalIds: model.loadGroupGlobalIds.slice(0, limit), resultGroupGlobalIds: model.resultGroupGlobalIds.slice(0, limit) })) };
}
