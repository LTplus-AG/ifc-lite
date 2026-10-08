/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * P-02 "Done means": the gate rejects 100% of a generated hallucination set
 * (fake entities, predefined types, attributes, psets, properties,
 * enumeration values and data types per IFC version) and accepts 100% of
 * the valid standard names used by the buildingSMART conformance corpus.
 *
 * "Valid" needs an oracle independent of the gate: the existing
 * `@ifc-lite/ids` document audit. A corpus facet counts only when the audit
 * raises nothing at its path (some pass-/fail- files deliberately use
 * names that are not standard, e.g. custom psets, and some names are only
 * valid in some versions). `invalid-` files are never used.
 */

import { auditIDSDocument, type IDSFacet, type IFCVersion } from '@ifc-lite/ids';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCorpus } from '../../test/corpus.js';
import { addFacet, eq, ids, prop, specDoc } from '../../test/gate-helpers.js';
import { createStudioDocument } from '../document/from-ids.js';
import { mintFacetNodes } from '../document/from-ids.js';
import { presentFields } from '../document/fields.js';
import type { FacetDraft, StudioOp } from '../ops/types.js';
import { checkOps } from './check.js';
import { createGateContext, type GateContext, type VersionTables } from './context.js';
import { single } from './grounding.js';
import type { GateCode } from './types.js';

let ctx: GateContext;
beforeAll(async () => {
  ctx = await createGateContext();
});

const NAME_CODES = new Set<GateCode>(['GATE-ENT-001', 'GATE-PDT-001', 'GATE-ATT-001', 'GATE-PSET-001', 'GATE-PROP-001', 'GATE-ENUM-001', 'GATE-DT-001']);

describe('corpus acceptance', () => {
  it('accepts every literal standard name the audit accepts in pass-/fail- cases', async () => {
    let checkedFacets = 0;
    let literalNames = 0;
    const wrongful: string[] = [];
    const userDefined: string[] = [];
    for (const { name, ids: parsed, xml } of loadCorpus()) {
      const audit = await auditIDSDocument(xml, { xsdValidation: false });
      const flagged = (path: string) => audit.issues.some((i) => i.path === path || i.path.startsWith(`${path}.`) || i.path.startsWith(`${path}[`));
      for (const [si, spec] of parsed.specifications.entries()) {
        const doc = createStudioDocument({ newId: ids });
        const specId = ids();
        const ops: StudioOp[] = [{ kind: 'spec.add', opId: ids(), payload: { specId, name: spec.name || 'x', ifcVersions: spec.ifcVersions } }];
        const paths: string[] = [];
        const add = (facet: IDSFacet, section: 'applicability' | 'requirements', path: string) => {
          ops.push({ kind: 'facet.restore', opId: ids(), payload: { specId, section, index: section === 'applicability' ? spec.applicability.facets.indexOf(facet) : paths.filter((p) => p.includes('requirements')).length, facet, nodes: mintFacetNodes(facet, ids), ...(section === 'requirements' ? { requirement: { optionality: 'required' } } : {}) } });
          paths.push(path);
        };
        spec.applicability.facets.forEach((f, j) => add(f, 'applicability', `specifications[${si}].applicability.facets[${j}]`));
        spec.requirements.forEach((r, j) => add(r.facet, 'requirements', `specifications[${si}].requirements[${j}]`));
        const result = checkOps(ops, doc, ctx);
        paths.forEach((path, k) => {
          if (flagged(path)) return;
          const facet = (ops[k + 1].payload as { facet: IDSFacet }).facet;
          checkedFacets++;
          literalNames += presentFields(facet).filter((f) => single(facetField(facet, f))).length;
          for (const issue of result.issues) {
            if (issue.opIndex !== k + 1 || !NAME_CODES.has(issue.code)) continue;
            // A predefinedType outside the enumeration on an entity that allows
            // USERDEFINED is an ObjectType match in IDS, not a standard name:
            // the gate asks for an explicit declaration (see gate-structural.test).
            if (issue.code === 'GATE-PDT-001' && issue.message.includes('declareUserDefinedType')) userDefined.push(`${issue.value}`);
            else wrongful.push(`${name} ${path}: ${issue.code} ${issue.message}`);
          }
        });
      }
    }
    expect(wrongful).toEqual([]);
    // partOf predefined types are user-defined values in these corpus cases (the audit does not check them).
    expect(userDefined.sort()).toEqual(['BUNNY', 'BURROW', 'LITTERBOX', 'SLABRADOR', 'WARREN', 'WATERBOTTLE']);
    expect(checkedFacets).toBeGreaterThan(300);
    expect(literalNames).toBeGreaterThan(400);
  }, 120_000);
});

function facetField(facet: IDSFacet, field: ReturnType<typeof presentFields>[number]) {
  switch (field) {
    case 'entity.name':
      return facet.type === 'entity' ? facet.name : undefined;
    case 'property.propertySet':
      return facet.type === 'property' ? facet.propertySet : undefined;
    case 'property.baseName':
      return facet.type === 'property' ? facet.baseName : undefined;
    case 'attribute.name':
      return facet.type === 'attribute' ? facet.name : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Hallucination set
// ---------------------------------------------------------------------------

interface Fake {
  label: string;
  versions: IFCVersion[];
  entity?: string;
  facet: FacetDraft;
  expect: GateCode;
}

/** Deterministic plausible-looking corruptions of a real name. */
function mutations(name: string): string[] {
  const mid = Math.floor(name.length / 2);
  return [
    `${name}s`,
    `${name.slice(0, mid)}${name.slice(mid + 1)}`,
    `${name.slice(0, mid)}${name[mid + 1] ?? ''}${name[mid]}${name.slice(mid + 2)}`,
    name.replace(/Common$/, 'General').replace(/^(Ifc|Pset_|Qto_)/, '$1Smart'),
  ].filter((m) => m !== name);
}

function every<T>(list: readonly T[], n: number): T[] {
  const step = Math.max(1, Math.floor(list.length / n));
  return list.filter((_, i) => i % step === 0).slice(0, n);
}

function hallucinations(t: VersionTables): Fake[] {
  const v = t.version as IFCVersion;
  const out: Fake[] = [];
  for (const e of every(t.entityNames, 25)) {
    for (const fake of mutations(e)) {
      if (!t.entities.has(fake.toUpperCase())) out.push({ label: `entity ${fake}`, versions: [v], facet: { type: 'entity', name: eq(fake) }, expect: 'GATE-ENT-001' });
    }
  }
  for (const e of every([...t.entities.values()].filter((x) => x.predefinedTypes.length > 2), 10)) {
    out.push({ label: `pdt ${e.name}.SMARTTYPE`, versions: [v], facet: { type: 'entity', name: eq(e.name), predefinedType: eq('SMARTTYPE') }, expect: 'GATE-PDT-001' });
  }
  for (const attr of ['FireRating', 'Colour', 'GlobalID2', 'ObjectTyp', 'Nmae']) {
    out.push({ label: `attribute IfcWall.${attr}`, versions: [v], entity: 'IfcWall', facet: { type: 'attribute', name: eq(attr) }, expect: 'GATE-ATT-001' });
  }
  const verifiable = t.psetNames.filter((n) => n.startsWith('Pset_') || t.hasQuantitySets);
  for (const p of every(verifiable, 20)) {
    for (const fake of mutations(p)) {
      if (!t.psets.has(fake) && (fake.startsWith('Pset_') || fake.startsWith('Qto_'))) {
        out.push({ label: `pset ${fake}`, versions: [v], facet: prop(fake, 'Reference'), expect: 'GATE-PSET-001' });
      }
    }
  }
  for (const p of every(t.psetNames.filter((n) => t.psets.get(n)!.properties.length > 0), 20)) {
    const real = t.psets.get(p)!.properties[0].name;
    for (const fake of mutations(real)) {
      if (!t.psets.get(p)!.properties.some((x) => x.name === fake)) {
        out.push({ label: `property ${p}.${fake}`, versions: [v], facet: prop(p, fake), expect: 'GATE-PROP-001' });
      }
    }
  }
  const enumerated = [...t.psets.values()].flatMap((p) => p.properties.filter((x) => x.kind === 'enumeration' && x.enumeration?.length).map((x) => ({ pset: p.name, prop: x })));
  for (const { pset, prop: x } of every(enumerated, 15)) {
    const fake = `${x.enumeration![0]}_PLUS`;
    out.push({ label: `enum ${pset}.${x.name}=${fake}`, versions: [v], facet: prop(pset, x.name, { value: eq(fake) }), expect: 'GATE-ENUM-001' });
  }
  for (const dt of every([...t.dataTypes.keys()], 10)) {
    for (const fake of mutations(dt)) {
      if (!t.dataTypes.has(fake.toUpperCase())) {
        out.push({ label: `dataType ${fake}`, versions: [v], facet: prop('Studio_Custom', 'X', { dataType: eq(fake) }), expect: 'GATE-DT-001' });
      }
    }
  }
  return out;
}

describe('hallucination set', () => {
  it('rejects 100% of generated fake names per version with the matching code', () => {
    const missed: string[] = [];
    let total = 0;
    for (const version of ['IFC2X3', 'IFC4', 'IFC4X3_ADD2'] as const) {
      const fakes = hallucinations(ctx.tables[version]);
      expect(fakes.length, version).toBeGreaterThan(150);
      for (const fake of fakes) {
        total++;
        const { doc, specId } = specDoc(fake.versions, fake.entity);
        // Fake data types are probed on a declared custom set, so only the type itself is wrong.
        const declare: StudioOp = { kind: 'meta.custom.declarePset', opId: ids(), payload: { decl: { name: 'Studio_Custom' } } };
        const section = fake.facet.type === 'entity' ? 'applicability' : 'requirements';
        const r = checkOps([declare, addFacet(specId, fake.facet, section)], doc, ctx);
        if (!r.issues.some((i) => i.code === fake.expect)) missed.push(`${version} ${fake.label}: ${JSON.stringify(r.issues.map((i) => i.code))}`);
      }
    }
    expect(missed).toEqual([]);
    expect(total).toBeGreaterThan(500);
  }, 120_000);
});
