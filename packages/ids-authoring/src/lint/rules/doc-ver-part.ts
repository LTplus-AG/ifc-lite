/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Document, version and partOf rules: IDSL-DOC-001, IDSL-VER-001, IDSL-PART-001. */

import type { IFCVersion, PartOfRelation } from '@ifc-lite/ids';
import { IFC2X3_MAPPED_ALIASES } from '@ifc-lite/ids';
import { inheritanceChain, type VersionTables } from '../../gate/context.js';
import { isReservedPsetName } from '../../gate/grounding-pset.js';
import { quickFix, type OpBody } from '../fix.js';
import type { DocumentRule, Finding, SpecRule, SpecView } from '../types.js';
import { allFacets, at, where } from '../walk.js';
import { applicabilityEntityNames, entityNameSites, gated, isSubtypeOf, literals, single, tables } from './util.js';

// IDS 1.0 XSD: author is `[^@]+@[^\.]+\..+`, date is xs:date.
const AUTHOR = /^[^@]+@[^.]+\..+$/;
const XS_DATE = /^-?\d{4,}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(Z|[+-]\d{2}:\d{2})?$/;

/** An unambiguous date in another notation, as xs:date. */
export function toXsDate(raw: string): string | undefined {
  const v = raw.trim();
  const pad = (n: string) => n.padStart(2, '0');
  let m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(v);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(v); // day.month.year (European dotted form)
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = /^(\d{4}-\d{2}-\d{2})T[\d:.]+(Z|[+-]\d{2}:\d{2})?$/.exec(v);
  if (m) return m[1];
  return undefined;
}

export const DOC_001: DocumentRule = {
  code: 'IDSL-DOC-001',
  area: 'DOC',
  scope: 'document',
  kind: 'static',
  defaultSeverity: 'error',
  title: 'Author is not an e-mail address, or date is not xs:date',
  rationale: 'The IDS 1.0 schema requires info/author to be an e-mail address and info/date to be an xs:date (YYYY-MM-DD). Schema-validating tools reject the file otherwise.',
  fix: 'Rewrite an unambiguous date as YYYY-MM-DD; remove an author that is not an e-mail address.',
  example: '<info><author>Jane Doe</author><date>08.10.2026</date></info>',
  check(_specs, { ctx, doc }) {
    const info = doc.ids.info;
    const out: Finding[] = [];
    const node = doc.nodes.document;
    if (info.author !== undefined && !AUTHOR.test(info.author)) {
      const fix = quickFix('Remove the author', this.code, node, 'author', [{ kind: 'doc.setInfo', payload: { field: 'author', value: null } }]);
      out.push({ nodeId: node, message: `author "${info.author}" is not an e-mail address`, fixes: gated(doc, ctx, [fix]) });
    }
    if (info.date !== undefined && !XS_DATE.test(info.date)) {
      const fixed = toXsDate(info.date);
      const fix = fixed ? quickFix(`Use ${fixed}`, this.code, node, 'date', [{ kind: 'doc.setInfo', payload: { field: 'date', value: fixed } }]) : undefined;
      out.push({ nodeId: node, message: `date "${info.date}" is not an xs:date (YYYY-MM-DD)`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};

/** Literal names used by a spec, with a resolver per version. */
function namesIn(spec: SpecView): { label: string; nodeId: string; field?: Parameters<typeof at>[1]; resolves: (t: VersionTables, v: IFCVersion) => boolean }[] {
  const out: ReturnType<typeof namesIn> = [];
  for (const site of entityNameSites(spec)) {
    for (const name of literals(site.constraint)) {
      out.push({ label: name, ...at(site.view, site.field), resolves: (t, v) => t.entities.has(name.toUpperCase()) || (v === 'IFC2X3' && IFC2X3_MAPPED_ALIASES.has(name.toUpperCase())) });
    }
  }
  for (const view of allFacets(spec)) {
    const f = view.facet;
    if (f.type === 'attribute') {
      for (const name of literals(f.name)) out.push({ label: name, ...at(view, 'attribute.name'), resolves: (t) => t.attributeNames.has(name) || [...t.attributeNames].some((a) => a.toLowerCase() === name.toLowerCase()) });
    }
    if (f.type === 'property') {
      const pset = single(f.propertySet);
      if (!pset || !isReservedPsetName(pset)) continue;
      out.push({ label: pset, ...at(view, 'property.propertySet'), resolves: (t) => t.psets.has(pset) || (pset.startsWith('Qto_') && !t.hasQuantitySets) });
      const name = single(f.baseName);
      if (name) out.push({ label: `${pset}.${name}`, ...at(view, 'property.baseName'), resolves: (t) => !t.psets.has(pset) || !!t.psets.get(pset)?.properties.some((p) => p.name === name) });
    }
  }
  return out;
}

export const VER_001: SpecRule = {
  code: 'IDSL-VER-001',
  area: 'VER',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Name valid in only some IFC versions of the specification',
  rationale:
    'A specification that lists several IFC versions must use names (entities, attributes, standard sets and properties) that exist in each of them. A name missing from one version makes the specification fail or select nothing on models of that version. IFC4 class names that the IFC2X3 occurrence/type mapping table resolves (IfcAirTerminal, …) are accepted for IFC2X3.',
  fix: 'Restrict the specification to the versions in which every name exists.',
  example: '<specification ifcVersion="IFC2X3 IFC4"> … <entity><name><simpleValue>IFCBUILDINGSYSTEM</simpleValue></name></entity>',
  check(spec, { ctx, doc }) {
    if (spec.versions.length < 2) return [];
    const out: Finding[] = [];
    const good = new Set(spec.versions);
    for (const n of namesIn(spec)) {
      const missing = spec.versions.filter((v) => !n.resolves(tables(ctx, v), v));
      if (!missing.length || missing.length === spec.versions.length) continue; // in none: the audit's problem, not a version split
      for (const v of missing) good.delete(v);
      out.push({ nodeId: n.nodeId, ...(n.field ? { field: n.field } : {}), message: `${n.label} does not exist in ${missing.join(', ')}` });
    }
    if (out.length && good.size) {
      const keep = spec.versions.filter((v) => good.has(v));
      const fix = quickFix(`Restrict to ${keep.join(', ')}`, this.code, spec.specId, keep.join(' '), [{ kind: 'spec.setIfcVersions', payload: { specId: spec.specId, versions: keep } }]);
      const fixes = gated(doc, ctx, [fix]);
      for (const f of out) f.fixes = fixes;
    }
    return out;
  },
};

const SPATIAL = 'IfcSpatialStructureElement';

function allAre(spec: SpecView, ctx: Parameters<SpecRule['check']>[1]['ctx'], ancestor: string, exclude?: string): boolean {
  const names = applicabilityEntityNames(spec);
  return (
    names.length > 0 &&
    spec.versions.every((v) => {
      const t = tables(ctx, v);
      return names.every((n) => inheritanceChain(t, n).length > 0 && isSubtypeOf(t, n, ancestor) && !(exclude && isSubtypeOf(t, n, exclude)));
    })
  );
}

export const PART_001: SpecRule = {
  code: 'IDSL-PART-001',
  area: 'PART',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'Unlikely partOf relation for these entities',
  rationale:
    'The relation is allowed by the schema but unusual for these entities. Building elements are placed in a storey or space by spatial containment (IfcRelContainedInSpatialStructure), not aggregation; spatial elements (sites, buildings, storeys) are decomposed by aggregation (IfcRelAggregates), not containment. The audit already rejects combinations the schema forbids.',
  fix: 'Use the usual relation.',
  example: '<entity>IFCWALL</entity> + <partOf relation="IFCRELAGGREGATES"><entity>IFCBUILDINGSTOREY</entity></partOf>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const view of allFacets(spec)) {
      const f = view.facet;
      if (f.type !== 'partOf' || !f.entity) continue;
      const whole = single(f.entity.name);
      if (!whole) continue;
      const wholeSpatial = spec.versions.every((v) => isSubtypeOf(tables(ctx, v), whole, SPATIAL));
      let suggestion: PartOfRelation | undefined;
      if ((f.relation === 'IfcRelAggregates' || f.relation === 'IfcRelNests') && wholeSpatial && allAre(spec, ctx, 'IfcElement')) suggestion = 'IfcRelContainedInSpatialStructure';
      if (f.relation === 'IfcRelContainedInSpatialStructure' && allAre(spec, ctx, SPATIAL)) suggestion = 'IfcRelAggregates';
      if (!suggestion) continue;
      const body: OpBody = { kind: 'facet.setRelation', payload: { facetId: view.facetId, relation: suggestion } };
      out.push({ nodeId: view.facetId, message: `${where(view)}: ${f.relation} is unusual here; ${suggestion} is the usual relation`, fixes: gated(doc, ctx, [quickFix(`Use ${suggestion}`, this.code, view.facetId, suggestion, [body])]) });
    }
    return out;
  },
};
