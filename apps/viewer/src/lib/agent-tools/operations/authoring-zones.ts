/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { viewerOperation as operation, emptySchema, pointSchema, type ViewerOperationContext } from './contract';
import { assertToolActive } from '../cancellation';
import type { ZoneSet } from '@/lib/zones/types';
import type { VolumeBasis } from '@/lib/zones/volume-basis';
import { zoneAssignmentSignature } from '@/lib/zones/assignment-signature';

const jsonOutput = { type: 'object', properties: { native_json: { type: 'string' } }, required: ['native_json'], additionalProperties: false };
const artifactOutput = { type: 'object', properties: { artifact_id: { type: 'string' }, filename: { type: 'string' }, mime_type: { type: 'string' }, bytes: { type: 'integer' } }, required: ['artifact_id', 'filename', 'mime_type', 'bytes'], additionalProperties: false };
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null, (_key, child: unknown) => child instanceof Map ? [...child] : child) });
const meta = (id: string, description: string, effect: 'read' | 'configuration' | 'selection' | 'artifact' = 'read') => ({ id, owner: 'zones', description, effects: [effect],
  capability: effect === 'read' ? 'read' as const : 'commands-and-edits' as const, implementation: 'native-store' as const,
  policy: effect === 'artifact' ? { artifact: 'native-export' as const } : undefined, outputSchema: effect === 'artifact' ? artifactOutput : jsonOutput });
function set(id: string): ZoneSet { const found = useViewerStore.getState().zoneSets.find(row => row.id === id); if (!found) throw new Error('Unknown native zone set.'); return found; }
function zoneOf(setId: string, zoneId: string) { const found = set(setId).zones.find(row => row.id === zoneId); if (!found) throw new Error('Unknown zone.'); return found; }
function revision(expected: string) { if (JSON.stringify(useViewerStore.getState().zoneSets) !== expected) throw new Error('Zone configuration changed. Inspect again.'); }
const idInput = { type: 'object' as const, properties: { set_id: { type: 'string' as const, minLength: 1, maxLength: 200 } }, required: ['set_id' as const], additionalProperties: false as const };
const basis = { type: 'string' as const, enum: ['mesh', 'net', 'gross', 'unqualified'] as VolumeBasis[] };
const expectedInput = { type: 'string' as const, maxLength: 1000000 };
function changes(c: ViewerOperationContext, expected: string, write: () => unknown) { revision(expected); return out(c.commit(write)); }
export const zoneOperations = [
  operation(meta('zones.read', 'Inspect complete native zone configuration and current assignment/apportionment results. Coordinates are renderer Y-up metres; rotations are radians.'), emptySchema, () => {
    const s = useViewerStore.getState(); return out({ configuration_json: JSON.stringify(s.zoneSets), sets: s.zoneSets, assignments: s.zoneAssignments, timing: s.zoneAssignmentTiming, apportionment: s.zoneApportionment });
  }),
  operation<{ name: string; expected_configuration: string }>(meta('zones.set.create', 'Create a native zone set after checking the exact configuration snapshot.', 'configuration'), {
    type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, expected_configuration: expectedInput }, required: ['name', 'expected_configuration'], additionalProperties: false,
  }, (i, c) => changes(c, i.expected_configuration, () => ({ set_id: useViewerStore.getState().createZoneSet(i.name) }))),
  operation<{ set_id: string; action: 'remove' | 'rename' | 'visibility'; name: string; visible: boolean; expected_configuration: string }>(meta('zones.set.edit', 'Remove/rename/show a native zone set through the exact panel store handlers.', 'configuration'), {
    type: 'object', properties: { ...idInput.properties, action: { type: 'string', enum: ['remove', 'rename', 'visibility'] }, name: { type: 'string', maxLength: 200 }, visible: { type: 'boolean' }, expected_configuration: expectedInput },
    required: ['set_id', 'action', 'name', 'visible', 'expected_configuration'], additionalProperties: false,
  }, (i, c) => changes(c, i.expected_configuration, () => { set(i.set_id); const s = useViewerStore.getState();
    if (i.action === 'remove') s.removeZoneSet(i.set_id); else if (i.action === 'rename') { if (!i.name.trim()) throw new Error('A zone set name is required.'); s.renameZoneSet(i.set_id, i.name); } else s.setZoneSetVisible(i.set_id, i.visible); return { sets: useViewerStore.getState().zoneSets };
  })),
  operation<{ set_id: string; zone_id: string; name: string; center: [number, number, number]; size: [number, number, number]; rotationY: number; expected_configuration: string }>(meta('zones.box.write', 'Create (empty zone_id) or numerically update an oriented native zone box in renderer Y-up metres/radians. A footprint prism keeps its plan centre, plan size and heading; only name, vertical centre and height may change.', 'configuration'), {
    type: 'object', properties: { ...idInput.properties, zone_id: { type: 'string', maxLength: 200 }, name: { type: 'string', minLength: 1, maxLength: 200 }, center: pointSchema, size: pointSchema, rotationY: { type: 'number' }, expected_configuration: expectedInput },
    required: ['set_id', 'zone_id', 'name', 'center', 'size', 'rotationY', 'expected_configuration'], additionalProperties: false,
  }, (i, c) => changes(c, i.expected_configuration, () => {
    set(i.set_id); if (i.size.some(value => value <= 0)) throw new Error('Zone box extents must be positive.');
    const patch = { name: i.name, center: i.center, size: i.size, rotationY: i.rotationY };
    if (i.zone_id) { const zone = zoneOf(i.set_id, i.zone_id);
      // A prism's plan extents and heading follow its footprint, so writing them would be dropped and reported as done (#10793).
      if (zone.footprint && (i.center[0] !== zone.center[0] || i.center[2] !== zone.center[2] || i.size[0] !== zone.size[0] || i.size[2] !== zone.size[2] || i.rotationY !== zone.rotationY))
        throw new Error('This zone is a footprint prism; only its name, vertical centre and height can be written.'); useViewerStore.getState().updateZone(i.set_id, i.zone_id, patch); }
    else useViewerStore.getState().addZone(i.set_id, patch); return { set: set(i.set_id) };
  })),
  operation<{ set_id: string; zone_id: string; expected_configuration: string }>(meta('zones.box.remove', 'Remove an exact existing native zone.', 'configuration'), {
    type: 'object', properties: { ...idInput.properties, zone_id: { type: 'string', minLength: 1, maxLength: 200 }, expected_configuration: expectedInput }, required: ['set_id', 'zone_id', 'expected_configuration'], additionalProperties: false,
  }, (i, c) => changes(c, i.expected_configuration, () => { zoneOf(i.set_id, i.zone_id); useViewerStore.getState().removeZone(i.set_id, i.zone_id); return { set: set(i.set_id) }; })),
  operation<{ json: string; expected_configuration: string }>(meta('zones.import', 'Import complete zone sets through the authoritative native parser. Supports native box/prism footprints and colors without a second geometry implementation.', 'configuration'), {
    type: 'object', properties: { json: { type: 'string', maxLength: 1000000 }, expected_configuration: expectedInput }, required: ['json', 'expected_configuration'], additionalProperties: false,
  }, (i, c) => changes(c, i.expected_configuration, () => { const result = useViewerStore.getState().importZoneSetsJSON(i.json); if (!result.ok) throw new Error(result.error); return { sets: useViewerStore.getState().zoneSets }; })),
  operation<{ set_id: string; expected_configuration: string }>(meta('zones.generateStoreys', 'Generate and replace a zone set using the same native current-storey geometry/frame service as the panel.', 'configuration'), {
    type: 'object', properties: { ...idInput.properties, expected_configuration: expectedInput }, required: ['set_id', 'expected_configuration'], additionalProperties: false,
  }, async (i, c) => { const { generateZonesFromStoreys } = await import('@/hooks/useZoneStoreyGeneration'); assertToolActive(c); const result = generateZonesFromStoreys(); if (!result.ok) throw new Error(result.error);
    return changes(c, i.expected_configuration, () => { set(i.set_id); useViewerStore.getState().replaceZonesInSet(i.set_id, result.zones); return { set: set(i.set_id) }; }); }),
  operation(meta('zones.assign', 'Recompute native assignments using the live renderer’s canonical entity bounds. Requires a mounted renderer; never fabricates an empty successful evaluation.'), emptySchema, async (_, c) => {
    const [{ getGlobalRenderer }, { recomputeZoneAssignmentsNow }] = await Promise.all([import('@/hooks/useBCF'), import('@/hooks/useZoneAssignmentSync')]);
    assertToolActive(c); if (!getGlobalRenderer()?.getScene()) throw new Error('A mounted native renderer is required for zone evaluation.');
    recomputeZoneAssignmentsNow(); const s = useViewerStore.getState(); return out({ assignments: s.zoneAssignments, timing: s.zoneAssignmentTiming });
  }),
  operation<{ set_id: string; zone_id: string }>(meta('zones.select', 'Select native assigned elements in a zone. Empty zone_id selects the unassigned bucket using the same federation-aware handler as the panel.', 'selection'), {
    type: 'object', properties: { ...idInput.properties, zone_id: { type: 'string', maxLength: 200 } }, required: ['set_id', 'zone_id'], additionalProperties: false,
  }, async (i, c) => { const { selectElementsInZone } = await import('@/hooks/useZoneSelection'); assertToolActive(c);
    // Selecting clears the user's selection first, so an unknown zone must be refused, not selected as empty (#10793).
    if (i.zone_id) zoneOf(i.set_id, i.zone_id); else set(i.set_id); return out(c.commit(() => ({ selected: selectElementsInZone(i.set_id, i.zone_id || null) }))); }),
  operation<{ set_id: string }>(meta('zones.apportion', 'Run native proved-solid volume apportionment for a current zone set. Native unavailable/unproved-solid diagnostics remain explicit.'), idInput, async (i, c) => {
    const [{ computeZoneApportionmentNow }, { getGlobalRenderer }] = await Promise.all([import('@/hooks/useZoneApportionment'), import('@/hooks/useBCF')]); assertToolActive(c);
    if (!getGlobalRenderer()?.getScene()) throw new Error('A mounted native renderer is required for apportionment.'); return out(computeZoneApportionmentNow(set(i.set_id)));
  }),
  operation(meta('zones.export', 'Export native zone definitions as a host-owned JSON artifact.', 'artifact'), emptySchema, (_, c) => {
    assertToolActive(c); return c.artifacts.create({ filename: 'zones.json', mimeType: 'application/json', data: useViewerStore.getState().exportZoneSetsJSON() });
  }),
  operation<{ set_id: string; basis: VolumeBasis; format: 'csv' | 'parquet' }>({ ...meta('zones.table.export', 'Export the canonical native per-element zone table as CSV or Parquet through the existing safe exporter.', 'artifact'), outputSchema: jsonOutput }, {
    type: 'object', properties: { ...idInput.properties, basis, format: { type: 'string', enum: ['csv', 'parquet'] } }, required: ['set_id', 'basis', 'format'], additionalProperties: false,
  }, async (i, c) => {
    const { exportZoneTable } = await import('@/hooks/useZoneTableExport'); assertToolActive(c); const zoneSet = set(i.set_id), identity = JSON.stringify(zoneSet);
    // The table reads models, geometry and assignments, not only the set, and Parquet encoding awaits: check them all.
    const before = useViewerStore.getState(), assignments = zoneAssignmentSignature(before.zoneAssignments, i.set_id);
    let captured: { bytes: Uint8Array; filename: string; mime: string } | undefined;
    const result = await exportZoneTable(zoneSet, i.basis, i.format, (bytes, filename, mime) => { captured = { bytes, filename, mime }; });
    assertToolActive(c); const now = useViewerStore.getState();
    if (identity !== JSON.stringify(set(i.set_id)) || now.models !== before.models || now.geometryUpdateTick !== before.geometryUpdateTick
      || now.mutationVersion !== before.mutationVersion || zoneAssignmentSignature(now.zoneAssignments, i.set_id) !== assignments) throw new Error('Zone configuration, models or assignments changed during export.');
    if (!captured) return out({ result, artifact: null }); const artifact = await c.artifacts.create({ filename: captured.filename, mimeType: captured.mime, data: captured.bytes }); return out({ result, artifact });
  }),
];
