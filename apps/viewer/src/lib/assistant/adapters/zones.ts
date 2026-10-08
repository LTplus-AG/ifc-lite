/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Location zones as evidence (#6833): the per-element x per-zone table the
 * Zones panel exports (`lib/zones/table.ts` `zoneTableRows`), on the mesh
 * basis the panel defaults to, for every zone set the live assignment covers.
 *
 * Read-only. Unlike the export, capture never runs the straddler clip
 * (`computeZoneApportionmentNow` writes the store and is the expensive path):
 * it reads the cached apportionment only while its revision still matches, and
 * a straddler without one is stated as "split not computed", never as a
 * geometry refusal it did not have.
 */

import type { ViewerState } from '@/store';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { coverageOf, validEntry, volumeBasisLabel, zoneSetRevision, zoneTableRows, type ZoneSet } from '@/lib/zones';
import { describeElement } from '@/hooks/useZoneTableExport';
import { zoneFactsFor } from '@/hooks/zoneFacts';
import { gatherProvedVolumes } from '@/hooks/useZoneApportionment';
import { evidenceRow, unavailableCapture, type EvidenceAdapter } from './types';

const BASIS = 'mesh' as const;
const SPLIT_NOT_COMPUTED = 'straddler split not computed for the current zones (run the zone volume split in the Zones panel)';

/** Short stable digest of the native revision string, which grows with every zone. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

interface SetCounts { assignedCount: number; straddlerCount: number; pairCount: number }

function countSet(s: ViewerState, setId: string): SetCounts {
  const counts = { assignedCount: 0, straddlerCount: 0, pairCount: 0 };
  for (const record of s.zoneAssignments.values()) {
    const assignment = record[setId];
    if (!assignment || assignment.touchedZoneIds.length === 0) continue;
    counts.assignedCount++;
    counts.pairCount += assignment.touchedZoneIds.length;
    if (assignment.straddles) counts.straddlerCount++;
  }
  return counts;
}

function setSummary(s: ViewerState, set: ZoneSet, counts: SetCounts) {
  const entry = validEntry(s.zoneApportionment, set);
  const coverage = entry ? coverageOf(entry) : null;
  return {
    zoneSetId: set.id, name: set.name, visible: set.visible,
    zoneSetRevision: digest(zoneSetRevision(set)),
    zoneCount: set.zones.length, ...counts,
    apportionmentComputed: entry !== null,
    // Refusals exist only once the split ran for these zones; unknown otherwise.
    refusedCount: coverage ? coverage.noGeometry + coverage.unprovedSolid + coverage.rescaledByAlignment : null,
    refusedByReason: coverage
      ? { noGeometry: coverage.noGeometry, unprovedSolid: coverage.unprovedSolid, rescaledByAlignment: coverage.rescaledByAlignment }
      : null,
    apportionedCount: coverage?.apportioned ?? null,
  };
}

function assignmentsComputed(s: ViewerState): boolean {
  return s.zoneSets.length > 0 && s.zoneAssignmentTiming !== null;
}

export const zonesAdapter: EvidenceAdapter = {
  id: 'zones', group: 'coordination', panelIds: ['zones'],
  titleKey: 'zonesPanel.header.title', descriptionKey: 'assistantSources.zones.description',
  rowMeaningKey: 'assistantSources.zones.rows', unavailableKey: 'assistantSources.zones.unavailable',
  suggestionKeys: ['assistantSources.zones.suggestSummary', 'assistantSources.zones.suggestUnmeasured'],
  readiness: s => {
    if (s.zoneSets.length === 0) return { status: { labelKey: 'assistantSources.zones.noSets' }, ready: false };
    if (s.zoneAssignmentTiming === null) return { status: { labelKey: 'assistantSources.zones.notAssigned' }, ready: false };
    return { status: { labelKey: 'assistantSources.zones.ready', params: { count: s.zoneSets.length } }, ready: true };
  },
  // Zone sets, the assignment and the apportionment cache are each replaced, never mutated.
  identity: s => [s.zoneSets, s.zoneAssignments, s.zoneApportionment],
  capture: (s, limit) => {
    if (!assignmentsComputed(s)) return unavailableCapture();
    const modelNames = new Map([...s.models].map(([id, model]) => [id, model.name ?? id]));
    // One pass over the loaded meshes, shared by every set, as the export does.
    const proved = gatherProvedVolumes();
    const rows: unknown[] = [];
    const sets = [];
    let totalRows = 0;
    for (const set of s.zoneSets) {
      const counts = countSet(s, set.id);
      sets.push(setSummary(s, set, counts));
      totalRows += counts.pairCount;
      if (rows.length >= limit) continue;
      const names = new Map(set.zones.map(zone => [zone.id, zone.name]));
      const apportioned = validEntry(s.zoneApportionment, set);
      for (const [globalId, record] of s.zoneAssignments) {
        if (rows.length >= limit) break;
        const assignment = record[set.id];
        if (!assignment || assignment.touchedZoneIds.length === 0) continue;
        // Mesh basis reads no declared quantity, so no quantity sets and no unit scale are needed.
        const facts = zoneFactsFor(globalId, assignment, names, BASIS, 1, [], proved, apportioned);
        const ref = resolveEntityRef(globalId);
        for (const row of zoneTableRows(describeElement(globalId, modelNames), facts, set.name, BASIS)) {
          if (rows.length >= limit) break;
          const unavailable = assignment.straddles && !apportioned ? SPLIT_NOT_COMPUTED : row.Unavailable;
          rows.push(evidenceRow({
            kind: 'zone-element', modelId: ref.modelId, globalId: row.GlobalId || null, expressId: row.ExpressId,
            unit: 'm3', status: row.VolumeM3 === null ? 'unmeasured' : 'measured',
          }, { ...row, ZoneSetId: set.id, Unavailable: unavailable }));
        }
      }
    }
    return {
      summary: {
        kind: 'zone-element-table', basis: volumeBasisLabel(BASIS), zoneSetCount: s.zoneSets.length,
        zoneCount: s.zoneSets.reduce((n, set) => n + set.zones.length, 0),
        assignedCount: sets.reduce((n, set) => n + set.assignedCount, 0),
        // Null as soon as one set has no current split: a partial sum would read as complete.
        refusedCount: sets.every(set => set.refusedCount !== null) ? sets.reduce((n, set) => n + (set.refusedCount ?? 0), 0) : null,
        zoneSets: sets,
        assignment: s.zoneAssignmentTiming ? { elementCount: s.zoneAssignmentTiming.elementCount,
          computedAt: new Date(s.zoneAssignmentTiming.computedAt).toISOString() } : null,
        units: { VolumeM3: 'm3', ElementVolumeM3: 'm3', Fraction: 'ratio 0..1 of the element volume' },
        limitations: 'One row per (element, zone) pair the element reaches, on the mesh volume basis only; declared NetVolume/GrossVolume bases are not read here. Elements reaching no zone are not rows. A null VolumeM3 is unmeasured with its reason, never zero. Straddler splits come only from a split already computed for the current zones; capture never runs the split. assignedCount is per zone set, so an element in several sets counts once per set.',
      },
      rows, totalRows, availability: 'available',
    };
  },
};
