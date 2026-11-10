/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The structural coverage catalogue (structural domain hill climb): one row per
 * concrete entity of the IFC structural analysis domain per schema, plus a
 * fixed set of capability rows.
 *
 * Entity rows are DERIVED, not typed: every concrete entity in the generated
 * buildingSMART tables (`packages/data/src/ifc-schema/generated/entities-*.ts`,
 * parsed by the same `parseEntityTable` the coverage ledger uses) whose
 * inheritance chain reaches one of the DOMAIN roots below. A schema update that
 * adds a structural subtype adds its row without anyone editing this file.
 *
 * Which levels apply to a row is decided by `notApplicable()` from the row's
 * family, never per row by hand. The rules are written next to it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEntityTable } from '../../scripts/lib/entity-table.mjs';
import { typeIndex } from './lib/values.mjs';

export const SCHEMAS = ['IFC2X3', 'IFC4', 'IFC4X3'];
export const ENTITY_LEVELS = ['fixture', 'read', 'card', 'render', 'create', 'edit', 'remove', 'convert'];
export const LEVELS = [...ENTITY_LEVELS, 'capability'];

/**
 * Domain roots. A concrete entity whose chain reaches `root` joins the
 * catalogue in that `family`. `only` names entities taken from a root whose
 * other descendants are not structural (IfcConnectionGeometry also covers
 * port and surface geometry of ordinary connections).
 */
export const DOMAIN = [
  { root: 'IfcStructuralItem', family: 'item' },
  { root: 'IfcStructuralActivity', family: 'activity' },
  { root: 'IfcStructuralLoadGroup', family: 'group' },
  { root: 'IfcStructuralResultGroup', family: 'group' },
  { root: 'IfcStructuralAnalysisModel', family: 'group' },
  { root: 'IfcStructuralLoad', family: 'resource' },
  { root: 'IfcBoundaryCondition', family: 'resource' },
  { root: 'IfcStructuralConnectionCondition', family: 'resource' },
  { root: 'IfcConnectionGeometry', family: 'resource', only: ['IfcConnectionPointEccentricity'] },
  { root: 'IfcRelConnectsStructuralMember', family: 'relationship' },
  { root: 'IfcRelConnectsStructuralActivity', family: 'relationship' },
  { root: 'IfcRelConnectsStructuralElement', family: 'relationship' },
];

/** The ancestor whose attributes are generic, not structural: an entity's "own" attributes start below it. */
export const FAMILY_BASE = { item: 'IfcProduct', activity: 'IfcProduct', group: 'IfcGroup', relationship: 'IfcRelConnects', resource: null };

/**
 * Capability rows: things the climb must deliver that are not one entity type.
 * Each is scored on the single `capability` level by the probe named here.
 */
export const CAPABILITIES = [
  { id: 'cap/physical-analytical-link-read', title: 'Read the physical-to-analytical link (IfcRelAssignsToProduct, IfcRelConnectsStructuralElement)', round: 'R1' },
  { id: 'cap/analytical-physical-toggle', title: 'Toggle between the analytical and the physical model in the viewer', round: 'R5' },
  { id: 'cap/derive-analytical-model', title: 'Derive an analytical model from the physical model', round: 'R6' },
  { id: 'cap/check-unlinked-load-bearing', title: 'Check: load-bearing element with no analytical counterpart', round: 'R7' },
  { id: 'cap/check-axis-drift', title: 'Check: analytical axis drifted from the physical element', round: 'R7' },
  { id: 'cap/check-unconnected-member', title: 'Check: structural member with no connection', round: 'R7' },
  { id: 'cap/check-stale-after-physical-change', title: 'Check: analytical model stale after a physical change', round: 'R7' },
  { id: 'cap/cli-structural-command', title: 'CLI structural command', round: 'R8' },
  { id: 'cap/docs-page', title: 'Structural analysis docs page', round: 'R8' },
];

/**
 * Not-applicable rules. Returns null when the level applies, otherwise the rule
 * that excludes it (the ledger prints the rule).
 */
export function notApplicable(row, level) {
  if (row.kind === 'capability') return level === 'capability' ? null : 'capability rows are scored on their capability probe only';
  if (level === 'capability') return 'entity rows are scored on the entity levels';
  if (level === 'render' && !['item', 'activity'].includes(row.family)) {
    return 'only members, connections and activities have a place in the 3D view; groups, resources and relationships are shown through them';
  }
  if (level === 'card' && row.family === 'relationship') {
    return 'a relationship is shown as the links on the cards of the items it connects, not as a card of its own';
  }
  if (level === 'convert' && row.schema === 'IFC4X3') {
    return 'the converter hop under test is IFC4 <-> IFC2X3';
  }
  return null;
}

/** Parsed entity table for one schema, with an inheritance-chain helper. */
export function schemaTable(root, schema) {
  const file = join(root, `packages/data/src/ifc-schema/generated/entities-${schema.toLowerCase()}.ts`);
  const table = parseEntityTable(readFileSync(file, 'utf8'));
  if (table.size === 0) throw new Error(`catalogue: no entities parsed from ${file}`);
  const chain = (name) => {
    const out = [];
    for (let e = table.get(name); e; e = table.get(e.parent)) out.push(e.name);
    return out;
  };
  const tables = { table, chain };
  return { ...tables, types: typeIndex(tables) };
}

/** Attributes declared below the family base: the ones a structural read has to carry. */
export function ownAttributes(tables, schema, entity, family) {
  const { table } = tables[schema];
  const all = table.get(entity)?.attributes ?? [];
  const base = FAMILY_BASE[family];
  const inherited = base ? new Set(table.get(base)?.attributes ?? []) : new Set();
  const own = all.filter((a) => !inherited.has(a));
  return base && all.includes('Name') && !own.includes('Name') ? ['Name', ...own] : own;
}

/** Derive the catalogue. Throws rather than return an empty domain. */
export function deriveCatalogue(root) {
  const tables = Object.fromEntries(SCHEMAS.map((s) => [s, schemaTable(root, s)]));
  const rows = [];
  for (const schema of SCHEMAS) {
    const { table, chain } = tables[schema];
    for (const e of [...table.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isAbstract) continue;
      const c = chain(e.name);
      const d = DOMAIN.find((dom) => c.includes(dom.root) && (!dom.only || dom.only.includes(e.name)));
      if (!d) continue;
      rows.push({
        id: `${schema}/${e.name}`,
        kind: 'entity',
        schema,
        entity: e.name,
        family: d.family,
        root: d.root,
        rooted: c.includes('IfcRoot'),
        attributes: e.attributes,
        own: ownAttributes(tables, schema, e.name, d.family),
      });
    }
  }
  for (const schema of SCHEMAS) {
    if (!rows.some((r) => r.schema === schema)) throw new Error(`catalogue: no structural entity derived for ${schema}`);
  }
  for (const cap of CAPABILITIES) rows.push({ ...cap, kind: 'capability' });
  return { rows, tables };
}
