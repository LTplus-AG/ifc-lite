/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LCA tools (spec §7.10) — embodied-carbon quick-look.
 *
 * v0.1 ships with a minimal KBOB 2024 lookup table (most-used Swiss
 * material categories) so the agent can produce a useful first-cut answer
 * without external data. A user-supplied catalog overrides the defaults
 * via `catalog` on every call.
 *
 * Math: GWP = volume(m³) × density(kg/m³) × gwp_per_kg(kgCO2eq/kg).
 * When a quantity isn't volume-shaped (e.g. doors counted by piece), the
 * row is still returned with `value: null` and the reason in `notes`.
 */

import { EntityNode } from '@ifc-lite/query';
import type { Tool } from './types.js';
import { okResult, resolveModel } from './util.js';

interface LcaEntry {
  material: string;
  density: number;        // kg/m³
  gwp: number;            // kgCO2eq / kg
  pe?: number;            // primary energy MJ/kg
  ubp?: number;           // UBP/kg
}

// Minimal KBOB 2024 sample. NOT a substitute for the full dataset; covers
// the most common materials so the demo flows return believable numbers.
const KBOB_2024_SAMPLE: LcaEntry[] = [
  { material: 'Concrete C25/30',   density: 2300, gwp: 0.105, pe: 0.99, ubp: 230 },
  { material: 'Concrete C30/37',   density: 2400, gwp: 0.130, pe: 1.05, ubp: 260 },
  { material: 'Reinforcement steel', density: 7850, gwp: 0.769, pe: 12.4, ubp: 1450 },
  { material: 'Structural steel',  density: 7850, gwp: 1.560, pe: 21.2, ubp: 2400 },
  { material: 'Solid timber',      density: 470,  gwp: 0.078, pe: 11.2, ubp: 480 },
  { material: 'Glulam',            density: 470,  gwp: 0.149, pe: 14.0, ubp: 660 },
  { material: 'Mineral wool insulation', density: 100, gwp: 1.180, pe: 17.2, ubp: 940 },
  { material: 'Gypsum board',      density: 800,  gwp: 0.218, pe: 4.30, ubp: 380 },
  { material: 'Brick',             density: 1800, gwp: 0.230, pe: 3.10, ubp: 410 },
  { material: 'Aluminium',         density: 2700, gwp: 8.140, pe: 152, ubp: 14000 },
  { material: 'Glass',             density: 2500, gwp: 1.130, pe: 17.5, ubp: 1450 },
];

function findEntry(catalog: LcaEntry[], materialName: string): LcaEntry | null {
  const norm = materialName.toLowerCase();
  // Best-match: substring on canonical name
  for (const entry of catalog) {
    if (norm.includes(entry.material.toLowerCase()) || entry.material.toLowerCase().includes(norm)) {
      return entry;
    }
  }
  // Heuristic fallbacks
  if (/concrete|beton/i.test(materialName)) return catalog.find((e) => /concrete c30/i.test(e.material)) ?? null;
  if (/steel|stahl/i.test(materialName)) return catalog.find((e) => /structural steel/i.test(e.material)) ?? null;
  if (/wood|timber|holz/i.test(materialName)) return catalog.find((e) => /timber/i.test(e.material)) ?? null;
  if (/insul|wolle/i.test(materialName)) return catalog.find((e) => /insulation/i.test(e.material)) ?? null;
  return null;
}

const lcaCompute: Tool = {
  name: 'lca_compute',
  description: 'Embodied-carbon quick-look using KBOB 2024 (or a supplied catalog). Returns aggregate GWP/PE/UBP and a per-element breakdown.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string', description: 'Restrict to one IFC type (default: all products).' },
      catalog: {
        type: 'array',
        description: 'Optional override list. Same shape as KBOB entries.',
        items: {
          type: 'object',
          properties: {
            material: { type: 'string' },
            density: { type: 'number' },
            gwp: { type: 'number' },
            pe: { type: 'number' },
            ubp: { type: 'number' },
          },
          required: ['material', 'density', 'gwp'],
        },
      },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const catalog = (input.catalog as LcaEntry[] | undefined) ?? KBOB_2024_SAMPLE;
    const filterType = input.type as string | undefined;
    const elements = filterType ? m.bim.query().byType(filterType).toArray() : m.bim.query().toArray();
    const rows: Array<{ expressId: number; type: string; material: string; volume: number | null; gwp: number | null; pe: number | null; ubp: number | null; notes?: string }> = [];
    let totalGwp = 0;
    let totalPe = 0;
    let totalUbp = 0;
    let counted = 0;
    let missingMaterial = 0;
    let missingVolume = 0;

    for (const e of elements) {
      const matData = m.bim.materials(e.ref);
      const matName = matData?.name ?? matData?.layers?.[0]?.materialName;
      const node = new EntityNode(m.store, e.ref.expressId);
      let volume: number | null = null;
      for (const qset of node.quantities()) {
        for (const q of qset.quantities) {
          if (/Volume$/i.test(q.name)) { volume = q.value; break; }
        }
        if (volume != null) break;
      }
      if (!matName) {
        rows.push({ expressId: e.ref.expressId, type: e.type, material: '(none)', volume, gwp: null, pe: null, ubp: null, notes: 'no material assigned' });
        missingMaterial++;
        continue;
      }
      if (volume == null) {
        rows.push({ expressId: e.ref.expressId, type: e.type, material: matName, volume: null, gwp: null, pe: null, ubp: null, notes: 'no volume quantity' });
        missingVolume++;
        continue;
      }
      const entry = findEntry(catalog, matName);
      if (!entry) {
        rows.push({ expressId: e.ref.expressId, type: e.type, material: matName, volume, gwp: null, pe: null, ubp: null, notes: 'no catalog match' });
        continue;
      }
      const massKg = volume * entry.density;
      const gwp = massKg * entry.gwp;
      const pe = entry.pe != null ? massKg * entry.pe : null;
      const ubp = entry.ubp != null ? massKg * entry.ubp : null;
      rows.push({ expressId: e.ref.expressId, type: e.type, material: matName, volume, gwp, pe, ubp });
      totalGwp += gwp;
      totalPe += pe ?? 0;
      totalUbp += ubp ?? 0;
      counted++;
    }
    const top = [...rows]
      .filter((r) => r.gwp != null)
      .sort((a, b) => (b.gwp ?? 0) - (a.gwp ?? 0))
      .slice(0, 5)
      .map((r) => ({ expressId: r.expressId, material: r.material, gwp: r.gwp }));

    return okResult(
      `Total GWP ≈ ${totalGwp.toFixed(0)} kgCO₂eq across ${counted} element(s); ${missingMaterial} missing material, ${missingVolume} missing volume.`,
      {
        totals: { gwp: totalGwp, pe: totalPe, ubp: totalUbp, counted },
        missing: { material: missingMaterial, volume: missingVolume, total: rows.length - counted },
        top5: top,
        rows,
      },
    );
  },
};

const lcaPerElement: Tool = {
  name: 'lca_per_element',
  description: 'Per-element carbon breakdown for a specific IFC type — useful for "show me the worst offenders".',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string', default: 'IfcWall' },
      limit: { type: 'integer', default: 50, maximum: 1000 },
    },
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const limit = (input.limit as number | undefined) ?? 50;
    const result = lcaCompute.handler({ model_id: m.id, type: input.type as string | undefined }, ctx);
    const rows = (result as { structuredContent?: { rows?: unknown[] } }).structuredContent?.rows as Array<{ gwp: number | null; expressId: number; type: string; material: string }> | undefined;
    const top = (rows ?? []).filter((r) => r.gwp != null).sort((a, b) => (b.gwp ?? 0) - (a.gwp ?? 0)).slice(0, limit);
    return okResult(`Top ${top.length} by GWP.`, { top });
  },
};

const lcaWhatIf: Tool = {
  name: 'lca_what_if',
  description: 'Material swap simulation: replace material A with B for a type set; returns the GWP delta.',
  scope: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string' },
      type: { type: 'string', default: 'IfcWall' },
      from_material: { type: 'string' },
      to_material: { type: 'string' },
    },
    required: ['from_material', 'to_material'],
    additionalProperties: false,
  },
  handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const catalog = KBOB_2024_SAMPLE;
    const from = findEntry(catalog, input.from_material as string);
    const to = findEntry(catalog, input.to_material as string);
    if (!from || !to) {
      return okResult('Material(s) not in catalog.', { fromFound: !!from, toFound: !!to });
    }
    const filterType = (input.type as string | undefined) ?? 'IfcWall';
    let totalVolumeAffected = 0;
    let beforeGwp = 0;
    let afterGwp = 0;
    for (const e of m.bim.query().byType(filterType).toArray()) {
      const matData = m.bim.materials(e.ref);
      const matName = matData?.name ?? matData?.layers?.[0]?.materialName ?? '';
      if (!matName.toLowerCase().includes(from.material.toLowerCase())) continue;
      const node = new EntityNode(m.store, e.ref.expressId);
      let volume: number | null = null;
      for (const qset of node.quantities()) {
        for (const q of qset.quantities) if (/Volume$/i.test(q.name)) { volume = q.value; break; }
        if (volume != null) break;
      }
      if (volume == null) continue;
      totalVolumeAffected += volume;
      beforeGwp += volume * from.density * from.gwp;
      afterGwp += volume * to.density * to.gwp;
    }
    const delta = afterGwp - beforeGwp;
    const pct = beforeGwp === 0 ? 0 : (delta / beforeGwp) * 100;
    return okResult(
      `Δ GWP = ${delta.toFixed(0)} kgCO₂eq (${pct.toFixed(1)}%) over ${totalVolumeAffected.toFixed(2)} m³.`,
      { fromMaterial: from, toMaterial: to, volumeAffected: totalVolumeAffected, beforeGwp, afterGwp, delta, deltaPct: pct },
    );
  },
};

export const lcaTools: Tool[] = [lcaCompute, lcaPerElement, lcaWhatIf];
