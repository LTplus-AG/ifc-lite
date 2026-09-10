/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { ownAppearanceQuery } from '../query-definition.js';
import type { AppearanceAssignment, AppearanceAssignmentRecipe, AssignmentQuery } from './types.js';
import type { AppearanceDraftSettings } from '../draft-types.js';
import { ASSIGNMENT_LIMITS, resolveAppearanceAssignments } from './resolve.js';
import { ownAssignmentSource } from './source.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid appearance assignment record.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 4096) throw new Error('Invalid appearance assignment identifier.');
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > ASSIGNMENT_LIMITS.members) throw new Error('Appearance assignment membership exceeds its limit.');
  return value.map(text);
}
function query(value: unknown): AssignmentQuery {
  const v = record(value);
  if (v.kind === 'model') return { kind: 'model' };
  if (v.kind === 'selection') return { kind: 'selection', GlobalIds: strings(v.GlobalIds) };
  if (v.kind === 'class') return { kind: 'class', ifcClass: text(v.ifcClass) };
  if (v.kind === 'filter') return { kind: 'filter', query: ownAppearanceQuery(v.query) };
  if (v.kind === 'type') return { kind: 'type', GlobalId: text(v.GlobalId) };
  throw new Error('Unknown appearance assignment scope.');
}
function settings(value: unknown): AppearanceDraftSettings {
  const v = record(value);
  if ((v.kind !== 'existingUv' && v.kind !== 'planar' && v.kind !== 'box') || (v.plane !== 'xy' && v.plane !== 'xz' && v.plane !== 'yz')
    || typeof v.repeatS !== 'boolean' || typeof v.repeatT !== 'boolean') throw new Error('Invalid appearance assignment mapping.');
  if (v.representationPolicy !== undefined && v.representationPolicy !== 'preserve' && v.representationPolicy !== 'evaluatedOccurrence') throw new Error('Unknown representation conversion policy.');
  for (const key of ['repeatU', 'repeatV', 'tileWidth', 'tileHeight', 'tileDepth', 'rotationDegrees', 'offsetU', 'offsetV', 'offsetW']) {
    if (typeof v[key] !== 'number' || !Number.isFinite(v[key])) throw new Error('Appearance mapping needs finite numbers.');
  }
  for (const key of ['tileWidth', 'tileHeight', 'tileDepth']) if ((v[key] as number) <= 0) throw new Error('Appearance tile dimensions must be positive.');
  // Native mapping validation remains authoritative for geometric interpretation.
  return { kind: v.kind, plane: v.plane, ...(v.representationPolicy === undefined ? {} : { representationPolicy: v.representationPolicy }), repeatS: v.repeatS, repeatT: v.repeatT,
    repeatU: v.repeatU as number, repeatV: v.repeatV as number, tileWidth: v.tileWidth as number,
    tileHeight: v.tileHeight as number, tileDepth: v.tileDepth as number, rotationDegrees: v.rotationDegrees as number,
    offsetU: v.offsetU as number, offsetV: v.offsetV as number, offsetW: v.offsetW as number };
}
function assignment(value: unknown): AppearanceAssignment {
  const v = record(value), model = record(v.model);
  if (!Array.isArray(v.members) || v.members.length > ASSIGNMENT_LIMITS.members) throw new Error('Appearance assignment membership exceeds its limit.');
  return { id: text(v.id), model: { slotId: text(model.slotId), modelId: text(model.modelId), name: text(model.name),
    sourceSha256: text(model.sourceSha256), revision: text(model.revision) },
    source: ownAssignmentSource(v.source), settings: settings(v.settings), query: query(v.query),
    members: v.members.map(raw => { const member = record(raw);
      if (!Number.isSafeInteger(member.expressId) || (member.expressId as number) <= 0) throw new Error('Invalid assignment object ID.');
      return { expressId: member.expressId as number, GlobalId: text(member.GlobalId) }; }),
    excludedGlobalIds: strings(v.excludedGlobalIds) };
}

/** Logical recipes only: no live model binding, image bytes, preview or plan can
 * be restored by this decoder. Callers must rebind and review membership first. */
export function parseAppearanceAssignments(json: string): AppearanceAssignmentRecipe {
  if (json.length > 4_000_000) throw new Error('Appearance assignments exceed the 4 MB recipe limit.');
  const v = record(JSON.parse(json));
  if (v.version !== 1 || !Array.isArray(v.assignments) || v.assignments.length > ASSIGNMENT_LIMITS.rows) {
    throw new Error('Unsupported appearance assignment recipe.');
  }
  const assignments = v.assignments.map(assignment);
  resolveAppearanceAssignments(assignments);
  return { version: 1, assignments };
}
export function serializeAppearanceAssignments(assignments: readonly AppearanceAssignment[]): string {
  const json = JSON.stringify({ version: 1, assignments });
  parseAppearanceAssignments(json);
  return json;
}
