/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { mutationPermission, mutationPermissionForModels } from '@/store/mutation-permission';
import { operation, viewerOperation, type OperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import type { ToolHost } from '../types';
import type { VolumeBasis } from '@/lib/zones/volume-basis';
import type { ZoneSet } from '@/lib/zones/types';
import { evictOldest, retainCandidate } from './host-handles';
import { boundedPage } from './result-limit';
import { stateRevision } from './state-revision';
import { invalidInput, stale } from './refusals';
import { mutationRefusal } from './mutation-refusal';
import { findZoneSet } from './authoring-zone-set';
import { captureZoneExportInputs, sameGeometry, sameModels } from './zone-operation-inputs';

const WRITEBACK_STALE = 'Zone/model inputs changed after review.';
const outputSchema = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const out = (value: unknown) => ({ native_json: JSON.stringify(value) });
const meta = (id: string, description: string, effect: 'read' | 'model' | 'artifact' = 'read') => ({ id, owner: 'zones', description, effects: [effect],
  capability: effect === 'read' ? 'read' as const : 'commands-and-edits' as const, implementation: 'native-store' as const, outputSchema,
  policy: effect === 'model' ? { model: 'native-reviewed' as const } : effect === 'artifact' ? { artifact: 'native-export' as const } : undefined });
type ViewerState = ReturnType<typeof useViewerStore.getState>;
interface Candidate { setId: string; basis: VolumeBasis; modelIds: string[]; action: 'write' | 'remove'; models: ViewerState['models']; revision: number; geometry: ViewerState['geometryResult']; content: number; inputs: string; result?: unknown }
const hosts = new WeakMap<ToolHost, Map<string, Candidate>>();
function owned(c: OperationContext) { let value = hosts.get(c.host); if (!value) { value = new Map(); hosts.set(c.host, value); } return value; }
function zoneSet(id: string) { const set = findZoneSet(id); if (!set) throw invalidInput('unknown-target', 'Unknown zone set.'); return set; }
interface Planners { buildZoneTable: typeof import('@/hooks/useZoneTableExport').buildZoneTable; planZoneRemoval: typeof import('@/hooks/useZoneWriteBack').planZoneRemoval }
/** The rows the apply acts on: a write's full facts table, or every element and owned set a removal deletes, including earlier output (#10795). */
function writebackRows(candidate: Pick<Candidate, 'action' | 'basis'>, set: ZoneSet, planners: Planners) {
  if (candidate.action === 'write') return { rows: planners.buildZoneTable(set, candidate.basis), removal: null };
  const removal = planners.planZoneRemoval(set);
  if (removal.blocked) throw invalidInput('refused', `Native zone writeback refused: ${removal.blocked}`);
  return { rows: removal.targets, removal };
}
/**
 * One digest of what the apply depends on (#10794): the zone set and the rows it acts on. A write's table reads the
 * assignments, apportionment and quantities the preview showed. An apply whose rebuilt digest differs is refused, so
 * it never acts on rows nobody reviewed.
 */
function writebackInputs(set: ZoneSet, rows: unknown) { return stateRevision({ set, rows }); }
/** Checks before the digest: models and geometry (identity first, a colour-tolerant walk on mismatch), mutation version, edit permission. */
function validate(candidate: Candidate) {
  const state = useViewerStore.getState();
  // Geometry too: a geometry-only update changes the proved volumes without touching mutationVersion, and an in-place
  // one (realignFederation) bumps only geometryContentVersion.
  if (!sameModels(state.models, candidate.models) || state.mutationVersion !== candidate.revision || !sameGeometry(state.geometryResult, candidate.geometry)
    || state.geometryContentVersion !== candidate.content) throw stale(WRITEBACK_STALE);
  // Equal but for colour: track the current objects, so the next check is an identity check, not another walk.
  candidate.models = state.models; candidate.geometry = state.geometryResult;
  const permission = mutationPermissionForModels(state, candidate.modelIds); if (!permission.allowed) throw mutationRefusal(permission.reason, candidate.modelIds.find(id => !mutationPermission(state, id).allowed), 'Native write refused: ');
}
/** The full check, once per apply and after permission: rebuild the digest of what the write would use. A removal returns the checked plan to delete. */
function validateInputs(candidate: Candidate, planners: Planners) {
  validate(candidate);
  const set = findZoneSet(candidate.setId);
  if (!set) throw stale(WRITEBACK_STALE);
  const { rows, removal } = writebackRows(candidate, set, planners);
  if (writebackInputs(set, rows) !== candidate.inputs) throw stale(WRITEBACK_STALE);
  return { set, removal };
}
export const zoneWriteOperations = [
  operation<{ set_id: string; model_ids: string[]; basis: VolumeBasis; action: 'write' | 'remove' }>(meta('zones.writeback.prepare', 'Prepare native zone property/quantity writeback or removal with explicit complete target model population. Write previews are the same native facts table as export; removal previews name each element and owned set to be removed, including earlier output. Either is row_count rows, with as many as fit the result limit (truncated says when some were left out; apply acts on every row, so review a truncated write table in full with zones.table.export; a truncated removal preview has no full listing). Native writeback reports per-model partial outcomes and uses explicit Remove as its inverse; it does not enter native Undo history.'), {
    type: 'object', properties: { set_id: { type: 'string', minLength: 1, maxLength: 200 }, model_ids: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 100, uniqueItems: true },
      basis: { type: 'string', enum: ['mesh', 'net', 'gross', 'unqualified'] }, action: { type: 'string', enum: ['write', 'remove'] } }, required: ['set_id', 'model_ids', 'basis', 'action'], additionalProperties: false,
  }, async (i, c) => {
    const [{ buildZoneTable }, { planZoneRemoval }] = await Promise.all([import('@/hooks/useZoneTableExport'), import('@/hooks/useZoneWriteBack')]);
    assertToolActive(c); const state = useViewerStore.getState();
    const current = [...state.models].filter(([, model]) => model.ifcDataStore).map(([id]) => id).sort();
    if (JSON.stringify([...i.model_ids].sort()) !== JSON.stringify(current) || !i.model_ids.includes(c.model.id)) throw invalidInput('wrong-target', 'model_ids must explicitly name every currently loaded IFC target.');
    const set = zoneSet(i.set_id), { rows } = writebackRows(i, set, { buildZoneTable, planZoneRemoval });
    const candidate: Candidate = { setId: i.set_id, basis: i.basis, modelIds: [...i.model_ids], action: i.action, models: state.models, revision: state.mutationVersion, geometry: state.geometryResult, content: state.geometryContentVersion,
      inputs: writebackInputs(set, rows) };
    validate(candidate); evictOldest(owned(c), 32); const token = crypto.randomUUID();
    retainCandidate(c, owned(c), token, candidate, { keep: entry => entry.result !== undefined });
    // The token covers every row; the preview carries as many as fit the result limit (#10794).
    const rest = { token, action: i.action, model_ids: i.model_ids, row_count: rows.length, truncated: true, undo: 'explicit-native-remove; not history Undo', partial_outcomes: true };
    // A one-page preview: nothing pages after it, so no list revision is needed.
    const sample = boundedPage<unknown>(rows, {}, rest, 'preview');
    return out({ ...rest, rows: sample.items, truncated: sample.next_offset !== null });
  }),
  operation<{ token: string }>(meta('zones.writeback.apply', 'Apply the exact reviewed whole-set native writeback/removal. Preserves native per-model eligibility, role checks, volume proofs and explicit partial outcome diagnostics.', 'model'), {
    type: 'object', properties: { token: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['token'], additionalProperties: false,
  }, async (i, c) => {
    const candidate = owned(c).get(i.token); if (!candidate) throw invalidInput('unknown-target', 'Unknown zone candidate for this host.'); if (candidate.result) return out(candidate.result);
    const [{ applyZoneWriteBack, removeZoneWriteBack, planZoneRemoval }, { buildZoneTable }] = await Promise.all([import('@/hooks/useZoneWriteBack'), import('@/hooks/useZoneTableExport')]);
    validate(candidate); assertToolActive(c);
    // A refusal throws inside commit, so it is never reported as a committed write.
    candidate.result = c.commit(() => {
      const { set, removal } = validateInputs(candidate, { buildZoneTable, planZoneRemoval });
      const result = removal ? removeZoneWriteBack(set, removal) : applyZoneWriteBack(set, candidate.basis);
      if (result.blocked) throw invalidInput('refused', `Native zone writeback refused: ${result.blocked}`);
      return result;
    });
    return out(candidate.result);
  }),
  // This export reads the whole scene. Its fence covers the full model set.
  viewerOperation<{ set_id: string; zone_id: string }>(meta('zones.geometry.export', 'Build a native GLB geometric section using the same proved-solid exact split service as the panel. Cancellation suppresses artifact publication; an already dispatched native worker may finish.', 'artifact'), {
    type: 'object', properties: { set_id: { type: 'string', minLength: 1, maxLength: 200 }, zone_id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['set_id', 'zone_id'], additionalProperties: false,
  }, async (i, c) => {
    const { exportZoneGeometry } = await import('@/hooks/useZoneGeometrySplit'); assertToolActive(c);
    const set = zoneSet(i.set_id), index = set.zones.findIndex(zone => zone.id === i.zone_id); if (index < 0) throw invalidInput('unknown-target', 'Unknown native zone.');
    const { current, release } = captureZoneExportInputs(set);
    try {
      let captured: { bytes: Uint8Array; filename: string } | undefined;
      const result = await exportZoneGeometry(set, index, { emit: (bytes, filename) => { captured = { bytes, filename }; } });
      assertToolActive(c);
      if (!current()) throw stale('Geometry or zones changed during native export. Discarded result.');
      if (!result.ok || !captured) return out({ result, artifact: null });
      const artifact = await c.artifacts.create({ filename: captured.filename, mimeType: 'model/gltf-binary', data: captured.bytes }); return out({ result, artifact });
    } finally { release(); }
  }),
];
