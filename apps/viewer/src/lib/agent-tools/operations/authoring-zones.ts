/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { viewerOperation as operation, emptySchema, pointSchema, type ViewerOperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import type { ZoneSet } from '@/lib/zones/types';
import type { VolumeBasis } from '@/lib/zones/volume-basis';
import { zoneSetRevision } from '@/lib/zones/apportionment-cache';
import { boundedPage, pageInput, type PageInput } from './result-limit';
import { assertRevision, revisionInput, stateRevision } from './state-revision';

const jsonOutput = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const artifactOutput = { type: 'object', properties: { artifact_id: { type: 'string' }, filename: { type: 'string' }, mime_type: { type: 'string' }, bytes: { type: 'integer' } }, required: ['artifact_id', 'filename', 'mime_type', 'bytes'], additionalProperties: false };
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null, (_key, child: unknown) => child instanceof Map ? [...child] : child) });
const meta = (id: string, description: string, effect: 'read' | 'configuration' | 'selection' | 'artifact' = 'read') => ({ id, owner: 'zones', description, effects: [effect],
  capability: effect === 'read' ? 'read' as const : 'commands-and-edits' as const, implementation: 'native-store' as const,
  policy: effect === 'artifact' ? { artifact: 'native-export' as const } : undefined, outputSchema: effect === 'artifact' ? artifactOutput : jsonOutput });
function set(id: string): ZoneSet { const found = useViewerStore.getState().zoneSets.find(row => row.id === id); if (!found) throw new Error('Unknown native zone set.'); return found; }
function revision(expected: string) { assertRevision(useViewerStore.getState().zoneSets, expected, 'Zone configuration changed. Inspect again.'); }
/**
 * zones.read pages flat rows under one cursor beside a fixed-size header (#10794): a `set` row per zone set (without
 * its zones), a `zone` row per zone, an `apportionment` row per computed set, an `apportioned` or `refused` row per
 * element of it, and an `assignment` row per element and set. A row grows only with its own item, never with the
 * configuration; one item too large for a page is refused with the offset to continue from. The rows are built once
 * per store change and dropped after the last page is read.
 */
type ZoneRow = { kind: string } & Record<string, unknown>;
const ZONE_ROW_KINDS = ['set', 'zone', 'apportionment', 'apportioned', 'refused', 'assignment'] as const;
let sequence: { from: readonly unknown[]; rows: ZoneRow[]; counts: Record<string, number>; configuration_revision: string; revision: string } | null = null;
function zoneRows(): NonNullable<typeof sequence> {
  const s = useViewerStore.getState(), from = [s.zoneSets, s.zoneApportionment, s.zoneAssignments];
  if (sequence && sequence.from.every((value, index) => value === from[index])) return sequence;
  const rows: ZoneRow[] = [];
  for (const { zones, ...set } of s.zoneSets) {
    rows.push({ kind: 'set', set: { ...set, zone_count: zones.length } });
    for (const zone of zones) rows.push({ kind: 'zone', set_id: set.id, zone });
  }
  for (const [set_id, entry] of s.zoneApportionment) {
    const current = s.zoneSets.find(row => row.id === set_id);
    // An edit after the run leaves the entry in place; stale says its volumes no longer describe the set.
    rows.push({ kind: 'apportionment', set_id, stale: !current || entry.revision !== zoneSetRevision(current), apportioned_count: entry.byElement.size,
      refused_count: entry.refused.size, computed_at: entry.computedAt, elapsed_ms: entry.elapsedMs });
    for (const [global_id, apportionment] of entry.byElement) rows.push({ kind: 'apportioned', set_id, global_id, apportionment });
    for (const [global_id, reason] of entry.refused) rows.push({ kind: 'refused', set_id, global_id, reason });
  }
  for (const [global_id, record] of s.zoneAssignments) for (const [set_id, assignment] of Object.entries(record)) rows.push({ kind: 'assignment', global_id, set_id, assignment });
  const counts: Record<string, number> = Object.fromEntries(ZONE_ROW_KINDS.map(kind => [kind, 0]));
  for (const row of rows) counts[row.kind]++;
  const configuration_revision = stateRevision(s.zoneSets);
  sequence = { from, rows, counts, configuration_revision, revision: stateRevision([configuration_revision, rows]) };
  return sequence;
}
function zonesPage(offset?: number | null) {
  const { rows, counts, configuration_revision, revision } = zoneRows();
  const header = { configuration_revision, timing: useViewerStore.getState().zoneAssignmentTiming, counts };
  const { items, ...page } = boundedPage(rows, offset, header);
  if (page.next_offset === null) sequence = null;
  return out({ ...header, rows: items, page: { ...page, revision } });
}
const idInput = { type: 'object' as const, properties: { set_id: { type: 'string' as const, minLength: 1, maxLength: 200 } }, required: ['set_id' as const], additionalProperties: false as const };
const basis = { type: 'string' as const, enum: ['mesh', 'net', 'gross', 'unqualified'] as VolumeBasis[] };
/** What a zone write reports: ids and counts only, never a set, so its result stays small however large the configuration grows. */
interface ZoneReceipt { set_id?: string; zone_id?: string | null; action?: string; set_count?: number; zone_count?: number }
/** Every zone write: check the caller's revision, commit, return the receipt and the configuration_revision the next write needs (#10794). */
function zoneWrite(c: ViewerOperationContext, expected: string, write: () => ZoneReceipt) {
  revision(expected); const receipt: ZoneReceipt = c.commit(write); return out({ ...receipt, configuration_revision: stateRevision(useViewerStore.getState().zoneSets) });
}
export const zoneOperations = [
  operation<PageInput>(meta('zones.read', 'Inspect native zones as flat rows, each tagged with kind: set (one per zone set, without its zones), zone, apportionment (one per computed set, with stale when the set changed since), apportioned and refused (one per element of it), and assignment (one per element and zone set). Every page carries configuration_revision (the expected_configuration of every zone edit; each edit also returns the next one), timing and counts by kind. Pass page.next_offset as offset until it is null, and restart from 0 if page.revision changes. Coordinates are renderer Y-up metres; rotations are radians.'), pageInput, (i) => zonesPage(i.offset)),
  operation<{ name: string; expected_configuration: string }>(meta('zones.set.create', 'Create a native zone set after checking the exact configuration revision. Returns set_id and the next configuration_revision.', 'configuration'), {
    type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, expected_configuration: revisionInput }, required: ['name', 'expected_configuration'], additionalProperties: false,
  }, (i, c) => zoneWrite(c, i.expected_configuration, () => ({ set_id: useViewerStore.getState().createZoneSet(i.name) }))),
  operation<{ set_id: string; action: 'remove' | 'rename' | 'visibility'; name: string; visible: boolean; expected_configuration: string }>(meta('zones.set.edit', 'Remove/rename/show a native zone set through the exact panel store handlers. Returns a receipt and the next configuration_revision; read sets with zones.read.', 'configuration'), {
    type: 'object', properties: { ...idInput.properties, action: { type: 'string', enum: ['remove', 'rename', 'visibility'] }, name: { type: 'string', maxLength: 200 }, visible: { type: 'boolean' }, expected_configuration: revisionInput },
    required: ['set_id', 'action', 'name', 'visible', 'expected_configuration'], additionalProperties: false,
  }, (i, c) => zoneWrite(c, i.expected_configuration, () => { set(i.set_id); const s = useViewerStore.getState();
    if (i.action === 'remove') s.removeZoneSet(i.set_id); else if (i.action === 'rename') { if (!i.name.trim()) throw new Error('A zone set name is required.'); s.renameZoneSet(i.set_id, i.name); } else s.setZoneSetVisible(i.set_id, i.visible); return { set_id: i.set_id, action: i.action };
  })),
  operation<{ set_id: string; zone_id: string; name: string; center: [number, number, number]; size: [number, number, number]; rotationY: number; expected_configuration: string }>(meta('zones.box.write', 'Create (empty zone_id) or numerically update an oriented native zone box in renderer Y-up metres/radians. Returns set_id, zone_id and the next configuration_revision.', 'configuration'), {
    type: 'object', properties: { ...idInput.properties, zone_id: { type: 'string', maxLength: 200 }, name: { type: 'string', minLength: 1, maxLength: 200 }, center: pointSchema, size: pointSchema, rotationY: { type: 'number' }, expected_configuration: revisionInput },
    required: ['set_id', 'zone_id', 'name', 'center', 'size', 'rotationY', 'expected_configuration'], additionalProperties: false,
  }, (i, c) => zoneWrite(c, i.expected_configuration, () => {
    const target = set(i.set_id); if (i.size.some(value => value <= 0)) throw new Error('Zone box extents must be positive.');
    const patch = { name: i.name, center: i.center, size: i.size, rotationY: i.rotationY };
    if (i.zone_id) { if (!target.zones.some(zone => zone.id === i.zone_id)) throw new Error('Unknown zone.'); useViewerStore.getState().updateZone(i.set_id, i.zone_id, patch); return { set_id: i.set_id, zone_id: i.zone_id }; }
    return { set_id: i.set_id, zone_id: useViewerStore.getState().addZone(i.set_id, patch) };
  })),
  operation<{ set_id: string; zone_id: string; expected_configuration: string }>(meta('zones.box.remove', 'Remove an exact existing native zone. Returns set_id, zone_id and the next configuration_revision.', 'configuration'), {
    type: 'object', properties: { ...idInput.properties, zone_id: { type: 'string', minLength: 1, maxLength: 200 }, expected_configuration: revisionInput }, required: ['set_id', 'zone_id', 'expected_configuration'], additionalProperties: false,
  }, (i, c) => zoneWrite(c, i.expected_configuration, () => { if (!set(i.set_id).zones.some(zone => zone.id === i.zone_id)) throw new Error('Unknown zone.'); useViewerStore.getState().removeZone(i.set_id, i.zone_id); return { set_id: i.set_id, zone_id: i.zone_id }; })),
  operation<{ json: string; expected_configuration: string }>(meta('zones.import', 'Import complete zone sets through the authoritative native parser. Supports native box/prism footprints and colors without a second geometry implementation. Returns the set count and the next configuration_revision; read sets with zones.read.', 'configuration'), {
    type: 'object', properties: { json: { type: 'string', maxLength: 1000000 }, expected_configuration: revisionInput }, required: ['json', 'expected_configuration'], additionalProperties: false,
  }, (i, c) => zoneWrite(c, i.expected_configuration, () => { const result = useViewerStore.getState().importZoneSetsJSON(i.json); if (!result.ok) throw new Error(result.error); return { set_count: useViewerStore.getState().zoneSets.length }; })),
  operation<{ set_id: string; expected_configuration: string }>(meta('zones.generateStoreys', 'Generate and replace a zone set using the same native current-storey geometry/frame service as the panel. Returns set_id, zone_count and the next configuration_revision.', 'configuration'), {
    type: 'object', properties: { ...idInput.properties, expected_configuration: revisionInput }, required: ['set_id', 'expected_configuration'], additionalProperties: false,
  }, async (i, c) => { const { generateZonesFromStoreys } = await import('@/hooks/useZoneStoreyGeneration'); assertToolActive(c); const result = generateZonesFromStoreys(); if (!result.ok) throw new Error(result.error);
    return zoneWrite(c, i.expected_configuration, () => { set(i.set_id); useViewerStore.getState().replaceZonesInSet(i.set_id, result.zones); return { set_id: i.set_id, zone_count: set(i.set_id).zones.length }; }); }),
  operation(meta('zones.assign', 'Recompute native assignments using the live renderer’s canonical entity bounds; returns element_count (every element evaluated, assigned or not) and the timing (read the assignments with zones.read). Requires a mounted renderer; never fabricates an empty successful evaluation.'), emptySchema, async (_, c) => {
    const [{ getGlobalRenderer }, { recomputeZoneAssignmentsNow }] = await Promise.all([import('@/hooks/useBCF'), import('@/hooks/useZoneAssignmentSync')]);
    assertToolActive(c); if (!getGlobalRenderer()?.getScene()) throw new Error('A mounted native renderer is required for zone evaluation.');
    recomputeZoneAssignmentsNow(); const s = useViewerStore.getState(); return out({ element_count: s.zoneAssignments.size, timing: s.zoneAssignmentTiming });
  }),
  operation<{ set_id: string; zone_id: string }>(meta('zones.select', 'Select native assigned elements in a zone. Empty zone_id selects the unassigned bucket using the same federation-aware handler as the panel.', 'selection'), {
    type: 'object', properties: { ...idInput.properties, zone_id: { type: 'string', maxLength: 200 } }, required: ['set_id', 'zone_id'], additionalProperties: false,
  }, async (i, c) => { const { selectElementsInZone } = await import('@/hooks/useZoneSelection'); assertToolActive(c); set(i.set_id); return out(c.commit(() => ({ selected: selectElementsInZone(i.set_id, i.zone_id || null) }))); }),
  operation<{ set_id: string }>(meta('zones.apportion', 'Run native proved-solid volume apportionment for a current zone set. Returns apportioned_count, refused_count, refusals by reason (no-geometry, unproved-solid, ...) and timing; the per-element rows are stored and read through zones.read as apportioned and refused rows.'), idInput, async (i, c) => {
    const [{ computeZoneApportionmentNow }, { getGlobalRenderer }] = await Promise.all([import('@/hooks/useZoneApportionment'), import('@/hooks/useBCF')]); assertToolActive(c);
    if (!getGlobalRenderer()?.getScene()) throw new Error('A mounted native renderer is required for apportionment.');
    // One record per element would pass the result limit on a large set after the entry was stored (#10794).
    const entry = computeZoneApportionmentNow(set(i.set_id)), refusals: Record<string, number> = {};
    for (const reason of entry.refused.values()) refusals[reason] = (refusals[reason] ?? 0) + 1;
    return out({ set_id: i.set_id, apportioned_count: entry.byElement.size, refused_count: entry.refused.size, refusals, computed_at: entry.computedAt, elapsed_ms: entry.elapsedMs });
  }),
  operation(meta('zones.export', 'Export native zone definitions as a host-owned JSON artifact.', 'artifact'), emptySchema, (_, c) => {
    assertToolActive(c); return c.artifacts.create({ filename: 'zones.json', mimeType: 'application/json', data: useViewerStore.getState().exportZoneSetsJSON() });
  }),
  operation<{ set_id: string; basis: VolumeBasis; format: 'csv' | 'parquet' }>({ ...meta('zones.table.export', 'Export the canonical native per-element zone table as CSV or Parquet through the existing safe exporter.', 'artifact'), outputSchema: jsonOutput }, {
    type: 'object', properties: { ...idInput.properties, basis, format: { type: 'string', enum: ['csv', 'parquet'] } }, required: ['set_id', 'basis', 'format'], additionalProperties: false,
  }, async (i, c) => {
    const { exportZoneTable } = await import('@/hooks/useZoneTableExport'); assertToolActive(c); const zoneSet = set(i.set_id), identity = JSON.stringify(zoneSet);
    let captured: { bytes: Uint8Array; filename: string; mime: string } | undefined;
    const result = await exportZoneTable(zoneSet, i.basis, i.format, (bytes, filename, mime) => { captured = { bytes, filename, mime }; });
    assertToolActive(c); if (identity !== JSON.stringify(set(i.set_id))) throw new Error('Zone configuration changed during export.');
    if (!captured) return out({ result, artifact: null }); const artifact = await c.artifacts.create({ filename: captured.filename, mimeType: captured.mime, data: captured.bytes }); return out({ result, artifact });
  }),
];
