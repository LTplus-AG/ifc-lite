/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { mutationPermissionForModels } from '@/store/mutation-permission';
import { operation, type OperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import type { ToolHost } from '../types';
import type { VolumeBasis } from '@/lib/zones/volume-basis';
import { zoneAssignmentSignature } from '@/lib/zones/assignment-signature';
import type { ZoneSet } from '@/lib/zones/types';
import { evictOldest } from './host-handles';
import { boundedPage } from './result-limit';
import { stateRevision } from './state-revision';
const outputSchema = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const out = (value: unknown) => ({ native_json: JSON.stringify(value) });
const meta = (id: string, description: string, effect: 'read' | 'model' | 'artifact' = 'read') => ({ id, owner: 'zones', description, effects: [effect],
  capability: effect === 'read' ? 'read' as const : 'commands-and-edits' as const, implementation: 'native-store' as const, outputSchema,
  policy: effect === 'model' ? { model: 'native-reviewed' as const } : effect === 'artifact' ? { artifact: 'native-export' as const } : undefined });
type ViewerState = ReturnType<typeof useViewerStore.getState>;
interface Candidate { setId: string; basis: VolumeBasis; modelIds: string[]; action: 'write' | 'remove'; models: ViewerState['models']; revision: number; geometry: ViewerState['geometryResult']; content: number; inputs: string;
  /** The set's assignments when reviewed: a removal walks the assignments, which the set digest does not cover. */
  assignments: string; result?: unknown }
const hosts = new WeakMap<ToolHost, Map<string, Candidate>>();
function owned(c: OperationContext) { let value = hosts.get(c.host); if (!value) { value = new Map(); hosts.set(c.host, value); } return value; }
function zoneSet(id: string) { const set = useViewerStore.getState().zoneSets.find(row => row.id === id); if (!set) throw new Error('Unknown zone set.'); return set; }
/** Same own fields, by identity, except `ignored`. */
function sameExcept(a: object, b: object, ignored: string) {
  const keys = Object.keys(a).filter(key => key !== ignored);
  return keys.length === Object.keys(b).filter(key => key !== ignored).length && keys.every(key => Object.hasOwn(b, key) && Reflect.get(a, key) === Reflect.get(b, key));
}
/**
 * Geometry as the proved volumes read it. A recolour replaces every mesh with `{ ...mesh, color }`, and with it
 * `geometryResult` and the `models` Map, but keeps each mesh's buffers; any other change still differs (#10669).
 */
function sameGeometry(a: ViewerState['geometryResult'] | undefined, b: ViewerState['geometryResult'] | undefined) {
  if (a === b) return true;
  if (!a || !b || a.meshes.length !== b.meshes.length || !sameExcept(a, b, 'meshes')) return false;
  return a.meshes.every((mesh, index) => sameExcept(mesh, b.meshes[index], 'color'));
}
/** Stricter than streaming-refresh's sameModelsExceptGeometry, which also ignores retained geometry. */
function sameModels(a: ViewerState['models'], b: ViewerState['models']) {
  if (a === b) return true;
  return a.size === b.size && [...a].every(([id, model]) => {
    const other = b.get(id);
    return other !== undefined && sameExcept(model, other, 'geometryResult') && sameGeometry(model.geometryResult, other.geometryResult);
  });
}
type BuildTable = typeof import('@/hooks/useZoneTableExport').buildZoneTable;
/**
 * One digest of what the write depends on (#10794). A write uses the zone set and its full facts table, which reads
 * the assignments, apportionment and quantities the preview showed; a removal uses only the zone set. An apply whose
 * rebuilt digest differs is refused, so a write never uses a table nobody reviewed.
 */
function writebackInputs(action: Candidate['action'], set: ZoneSet, rows?: unknown) { return stateRevision(action === 'write' ? { set, rows } : { set }); }
/** Checks before the digest: models and geometry (identity first, a colour-tolerant walk on mismatch), mutation version, edit permission. */
function validate(candidate: Candidate) {
  const state = useViewerStore.getState();
  // Geometry too: a geometry-only update changes the proved volumes without touching mutationVersion, and an in-place
  // one (realignFederation) bumps only geometryContentVersion.
  if (!sameModels(state.models, candidate.models) || state.mutationVersion !== candidate.revision || !sameGeometry(state.geometryResult, candidate.geometry)
    || state.geometryContentVersion !== candidate.content) throw new Error('Zone/model inputs changed after review.');
  if (zoneAssignmentSignature(state.zoneAssignments, candidate.setId) !== candidate.assignments) throw new Error('Zone assignments changed after review. Prepare again.');
  // Equal but for colour: track the current objects, so the next check is an identity check, not another walk.
  candidate.models = state.models; candidate.geometry = state.geometryResult;
  const permission = mutationPermissionForModels(state, candidate.modelIds); if (!permission.allowed) throw new Error(`Native write refused: ${permission.reason}`);
}
/** The full check, once per apply and after permission: rebuild the digest of what the write would use. */
function validateInputs(candidate: Candidate, build: BuildTable) {
  validate(candidate); const set = zoneSet(candidate.setId);
  if (writebackInputs(candidate.action, set, candidate.action === 'write' ? build(set, candidate.basis) : undefined) !== candidate.inputs) throw new Error('Zone/model inputs changed after review.');
  return set;
}
export const zoneWriteOperations = [
  operation<{ set_id: string; model_ids: string[]; basis: VolumeBasis; action: 'write' | 'remove' }>(meta('zones.writeback.prepare', 'Prepare native zone property/quantity writeback or removal with explicit complete target model population. The preview is the same native facts table as export: row_count rows, with as many as fit the result limit (truncated says when some were left out; apply writes every row, so review a truncated table in full with zones.table.export). Native writeback reports per-model partial outcomes and uses explicit Remove as its inverse; it does not enter native Undo history.'), {
    type: 'object', properties: { set_id: { type: 'string', minLength: 1, maxLength: 200 }, model_ids: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 100, uniqueItems: true },
      basis: { type: 'string', enum: ['mesh', 'net', 'gross', 'unqualified'] }, action: { type: 'string', enum: ['write', 'remove'] } }, required: ['set_id', 'model_ids', 'basis', 'action'], additionalProperties: false,
  }, async (i, c) => {
    const { buildZoneTable } = await import('@/hooks/useZoneTableExport'); assertToolActive(c); const state = useViewerStore.getState();
    const current = [...state.models].filter(([, model]) => model.ifcDataStore).map(([id]) => id).sort();
    if (JSON.stringify([...i.model_ids].sort()) !== JSON.stringify(current) || !i.model_ids.includes(c.model.id)) throw new Error('model_ids must explicitly name every currently loaded IFC target.');
    const set = zoneSet(i.set_id), rows = buildZoneTable(set, i.basis);
    const candidate: Candidate = { setId: i.set_id, basis: i.basis, modelIds: [...i.model_ids], action: i.action, models: state.models, revision: state.mutationVersion, geometry: state.geometryResult, content: state.geometryContentVersion,
      inputs: writebackInputs(i.action, set, rows), assignments: zoneAssignmentSignature(state.zoneAssignments, i.set_id) };
    validate(candidate); evictOldest(owned(c), 32); const token = crypto.randomUUID(); owned(c).set(token, candidate);
    // The token covers every row; the preview carries as many as fit the result limit (#10794).
    const rest = { token, action: i.action, model_ids: i.model_ids, row_count: rows.length, truncated: true, undo: 'explicit-native-remove; not history Undo', partial_outcomes: true };
    // A one-page preview: nothing pages after it, so no list revision is needed.
    const sample = boundedPage(rows, {}, rest, 'preview');
    return out({ ...rest, rows: sample.items, truncated: sample.next_offset !== null });
  }),
  operation<{ token: string }>(meta('zones.writeback.apply', 'Apply the exact reviewed whole-set native writeback/removal. Preserves native per-model eligibility, role checks, volume proofs and explicit partial outcome diagnostics.', 'model'), {
    type: 'object', properties: { token: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['token'], additionalProperties: false,
  }, async (i, c) => {
    const candidate = owned(c).get(i.token); if (!candidate) throw new Error('Unknown zone candidate for this host.'); if (candidate.result) return out(candidate.result);
    const [{ applyZoneWriteBack, removeZoneWriteBack }, { buildZoneTable }] = await Promise.all([import('@/hooks/useZoneWriteBack'), import('@/hooks/useZoneTableExport')]);
    validate(candidate); assertToolActive(c);
    // A refusal throws inside commit, so it is never reported as a committed write.
    candidate.result = c.commit(() => {
      const set = validateInputs(candidate, buildZoneTable);
      const result = candidate.action === 'write' ? applyZoneWriteBack(set, candidate.basis) : removeZoneWriteBack(set);
      if (result.blocked) throw new Error(`Native zone writeback refused: ${result.blocked}`);
      return result;
    });
    return out(candidate.result);
  }),
  operation<{ set_id: string; zone_id: string }>(meta('zones.geometry.export', 'Build a native GLB geometric section using the same proved-solid exact split service as the panel. Cancellation suppresses artifact publication; an already dispatched native worker may finish.', 'artifact'), {
    type: 'object', properties: { set_id: { type: 'string', minLength: 1, maxLength: 200 }, zone_id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['set_id', 'zone_id'], additionalProperties: false,
  }, async (i, c) => {
    const { exportZoneGeometry } = await import('@/hooks/useZoneGeometrySplit'); assertToolActive(c);
    const set = zoneSet(i.set_id), index = set.zones.findIndex(zone => zone.id === i.zone_id); if (index < 0) throw new Error('Unknown native zone.');
    const state = useViewerStore.getState(), signature = JSON.stringify(set), models = state.models, tick = state.geometryUpdateTick, revision = state.mutationVersion;
    let captured: { bytes: Uint8Array; filename: string } | undefined;
    const result = await exportZoneGeometry(set, index, { emit: (bytes, filename) => { captured = { bytes, filename }; } });
    assertToolActive(c); const now = useViewerStore.getState();
    if (now.models !== models || now.geometryUpdateTick !== tick || now.mutationVersion !== revision || JSON.stringify(zoneSet(i.set_id)) !== signature) throw new Error('Geometry or zones changed during native export. Discarded result.');
    if (!result.ok || !captured) return out({ result, artifact: null });
    const artifact = await c.artifacts.create({ filename: captured.filename, mimeType: 'model/gltf-binary', data: captured.bytes }); return out({ result, artifact });
  }),
];
