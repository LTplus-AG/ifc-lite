/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Seeded random generator of VALID primitive ops for the current state of
 * a Studio document. Drives the reducer's property tests (IDS-019).
 */

import type { IDSFacet, IFCVersion, PartOfRelation } from '@ifc-lite/ids';
import { FACET_FIELDS, getField, REQUIRED_FIELDS, type FacetFieldName } from '../src/document/fields.js';
import type { Section, StudioDocument } from '../src/document/types.js';
import type { ConstraintDraft, FacetDraft, InfoField, PrimitiveOp, ValueInput } from '../src/ops/types.js';

export type Rng = () => number;

/** mulberry32: small, fast, well-distributed 32-bit PRNG. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];
const int = (rng: Rng, n: number): number => Math.floor(rng() * n);

const VERSIONS: IFCVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3_ADD2'];
const RELATIONS: PartOfRelation[] = ['IfcRelAggregates', 'IfcRelContainedInSpatialStructure', 'IfcRelNests', 'IfcRelAssignsToGroup'];
const WORDS = ['IfcWall', 'IfcDoor', 'Pset_WallCommon', 'FireRating', 'EI60', 'Concrete', 'A-01', 'IsExternal'];

export function randomDraft(rng: Rng, depth = 0): ConstraintDraft {
  switch (int(rng, depth > 0 ? 7 : 8)) {
    case 0:
      return { kind: 'equals', value: pick(rng, [pick(rng, WORDS), int(rng, 100), rng() < 0.5]) };
    case 1:
      return { kind: 'oneOf', values: [pick(rng, WORDS), pick(rng, WORDS), int(rng, 9)] };
    case 2:
      return { kind: 'pattern', pattern: pick(rng, ['[A-Z]+', 'EI[0-9]{2}', 'Ifc.*', 'A-\\d+']) };
    case 3:
      return { kind: 'range', min: int(rng, 100), max: 100 + int(rng, 1000), unit: pick(rng, ['mm', 'm', 'kN']) };
    case 4:
      return { kind: 'length', min: int(rng, 3), max: 3 + int(rng, 5) };
    case 5:
      return { kind: 'digits', total: 1 + int(rng, 8), fraction: int(rng, 2) };
    case 6:
      return { kind: 'equals', value: pick(rng, WORDS) };
    default:
      return { kind: 'all', of: [{ kind: 'pattern', pattern: '[A-Z0-9]+' }, { kind: 'length', max: 1 + int(rng, 9) }] };
  }
}

function randomValue(rng: Rng): ValueInput {
  if (rng() < 0.1) return { kind: 'raw', constraint: { type: 'simpleValue', value: pick(rng, WORDS) } };
  return randomDraft(rng);
}

export function randomFacetDraft(rng: Rng): FacetDraft {
  const v = () => randomValue(rng);
  const maybe = () => (rng() < 0.5 ? v() : undefined);
  const strip = <T extends object>(o: T): T =>
    Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as T;
  switch (int(rng, 6)) {
    case 0:
      return strip({ type: 'entity', name: v(), predefinedType: maybe() });
    case 1:
      return strip({ type: 'attribute', name: v(), value: maybe() });
    case 2:
      return strip({ type: 'property', propertySet: v(), baseName: v(), dataType: maybe(), value: maybe() });
    case 3:
      return strip({ type: 'classification', system: maybe(), value: maybe() });
    case 4:
      return strip({ type: 'material', value: maybe() });
    default:
      return rng() < 0.8
        ? { type: 'partOf', relation: pick(rng, RELATIONS), entity: strip({ name: v(), predefinedType: maybe() }) }
        : { type: 'partOf', relation: pick(rng, RELATIONS) };
  }
}

interface FacetRef {
  specId: string;
  facetId: string;
  section: Section;
  facet: IDSFacet;
  index: number;
}

function facets(doc: StudioDocument): FacetRef[] {
  const out: FacetRef[] = [];
  doc.ids.specifications.forEach((spec, i) => {
    const nodes = doc.nodes.specs[i];
    spec.applicability.facets.forEach((facet, j) =>
      out.push({ specId: spec.id, facetId: nodes.applicability[j].id, section: 'applicability', facet, index: j }),
    );
    spec.requirements.forEach((r, j) =>
      out.push({ specId: spec.id, facetId: r.id, section: 'requirements', facet: r.facet, index: j }),
    );
  });
  return out;
}

/** One valid primitive op for `doc`, or `undefined` if the pick does not fit. */
export function randomOp(rng: Rng, doc: StudioDocument, newId: () => string): PrimitiveOp | undefined {
  const opId = newId();
  const specs = doc.ids.specifications;
  const all = facets(doc);
  const spec = specs.length ? pick(rng, specs) : undefined;
  const f = all.length ? pick(rng, all) : undefined;
  switch (int(rng, 30)) {
    case 0:
      return { kind: 'doc.setInfo', opId, payload: { field: pick(rng, ['title', 'author', 'purpose'] as InfoField[]), value: pick(rng, WORDS) } };
    case 21:
      return { kind: 'doc.setInfo', opId, payload: { field: pick(rng, ['author', 'purpose', 'milestone'] as InfoField[]), value: null } };
    case 1:
      return {
        kind: 'spec.add',
        opId,
        payload: { specId: newId(), index: int(rng, specs.length + 1), name: pick(rng, WORDS), ifcVersions: [pick(rng, VERSIONS)], cardinality: pick(rng, ['required', 'optional', 'prohibited'] as const) },
      };
    case 2:
      return spec && { kind: 'spec.remove', opId, payload: { specId: spec.id } };
    case 3:
      return spec && { kind: 'spec.duplicate', opId, payload: { specId: spec.id, newSpecId: newId() } };
    case 4:
      return spec && { kind: 'spec.move', opId, payload: { specId: spec.id, toIndex: int(rng, specs.length) } };
    case 5:
      return spec && { kind: 'spec.set', opId, payload: { specId: spec.id, field: pick(rng, ['name', 'description', 'identifier'] as const), value: pick(rng, WORDS) } };
    case 6:
      return spec && { kind: 'spec.set', opId, payload: { specId: spec.id, field: pick(rng, ['description', 'instructions', 'identifier'] as const), value: null } };
    case 7:
      return spec && { kind: 'spec.setCardinality', opId, payload: { specId: spec.id, cardinality: pick(rng, ['required', 'optional', 'prohibited'] as const) } };
    case 8:
      return spec && { kind: 'spec.setIfcVersions', opId, payload: { specId: spec.id, versions: [pick(rng, VERSIONS), pick(rng, VERSIONS)] } };
    case 9:
    case 23:
    case 24:
    case 25:
    case 26: {
      // Weighted up so sections grow past one facet and reorders bite.
      if (!spec) return undefined;
      const section: Section = rng() < 0.5 ? 'applicability' : 'requirements';
      const len = section === 'applicability' ? spec.applicability.facets.length : spec.requirements.length;
      return {
        kind: 'facet.add',
        opId,
        payload: {
          specId: spec.id,
          section,
          facetId: newId(),
          index: int(rng, len + 1),
          facet: randomFacetDraft(rng),
          ...(section === 'requirements' ? { optionality: pick(rng, ['required', 'optional', 'prohibited'] as const), description: 'd' } : {}),
        },
      };
    }
    case 10:
      return f && { kind: 'facet.remove', opId, payload: { facetId: f.facetId } };
    case 11: {
      if (!f || !spec) return undefined;
      // Half the moves stay within the facet's own spec, so reorders are common.
      const target = rng() < 0.5 ? (specs.find((s) => s.id === f.specId) ?? spec) : spec;
      const toSection: Section = rng() < 0.5 ? f.section : f.section === 'applicability' ? 'requirements' : 'applicability';
      const same = target.id === f.specId && toSection === f.section;
      const len = toSection === 'applicability' ? target.applicability.facets.length : target.requirements.length;
      const toIndex = same ? (len > 1 ? (f.index + 1 + int(rng, len - 1)) % len : 0) : int(rng, len + 1);
      return { kind: 'facet.move', opId, payload: { facetId: f.facetId, toSpecId: target.id, toSection, toIndex } };
    }
    case 12:
      return f && { kind: 'facet.replace', opId, payload: { facetId: f.facetId, facet: randomFacetDraft(rng) } };
    case 13:
    case 14: {
      if (!f) return undefined;
      const field = pick(rng, FACET_FIELDS[f.facet.type] as readonly FacetFieldName[]);
      if (field === 'partOf.entity.predefinedType' && !getField(f.facet, 'partOf.entity.name')) return undefined;
      const clear = !REQUIRED_FIELDS.has(field) && rng() < 0.3;
      if (clear) return { kind: 'facet.setField', opId, payload: { facetId: f.facetId, field, value: null } };
      return { kind: rng() < 0.5 ? 'facet.setField' : 'value.set', opId, payload: { facetId: f.facetId, field, value: randomValue(rng) } };
    }
    case 15:
      return f?.facet.type === 'partOf' ? { kind: 'facet.setRelation', opId, payload: { facetId: f.facetId, relation: pick(rng, RELATIONS) } } : undefined;
    case 16:
      return f?.section === 'requirements'
        ? { kind: 'requirement.setOptionality', opId, payload: { facetId: f.facetId, optionality: pick(rng, ['required', 'optional', 'prohibited'] as const) } }
        : undefined;
    case 17:
      return f?.section === 'requirements'
        ? { kind: 'requirement.set', opId, payload: { facetId: f.facetId, field: pick(rng, ['description', 'instructions'] as const), value: rng() < 0.4 ? null : pick(rng, WORDS) } }
        : undefined;
    case 18: {
      if (!f) return undefined;
      const field = pick(rng, FACET_FIELDS[f.facet.type] as readonly FacetFieldName[]);
      const c = getField(f.facet, field);
      if (c && c.type !== 'simpleValue' && c.type !== 'enumeration') return undefined;
      if (field === 'partOf.entity.predefinedType' && !getField(f.facet, 'partOf.entity.name')) return undefined;
      return { kind: 'value.addEnumValue', opId, payload: { facetId: f.facetId, field, value: pick(rng, WORDS) } };
    }
    case 19: {
      if (!f) return undefined;
      for (const field of FACET_FIELDS[f.facet.type] as readonly FacetFieldName[]) {
        const c = getField(f.facet, field);
        if (c?.type === 'enumeration' && c.values.length > 1) {
          return { kind: 'value.removeEnumValue', opId, payload: { facetId: f.facetId, field, value: pick(rng, c.values) } };
        }
      }
      return undefined;
    }
    case 27:
      // Import leftovers (non-canonical raw attributes) must survive undo.
      return f?.section === 'requirements'
        ? { kind: 'facet.patch', opId, payload: { facetId: f.facetId, set: { cardinalityRaw: 'Optional', optionality: 'optional' } } }
        : undefined;
    case 28:
      return spec && { kind: 'spec.patch', opId, payload: { specId: spec.id, set: { ifcVersionRaw: 'ifc4', applicabilityCardinality: 'required', maxOccurs: 'unbounded' } } };
    case 29:
      return f?.facet.type === 'partOf' ? { kind: 'facet.patch', opId, payload: { facetId: f.facetId, set: { rawRelation: 'IFCRELBOGUS' } } } : undefined;
    case 20:
      return { kind: 'meta.custom.declarePset', opId, payload: { decl: { name: pick(rng, ['Acme_A', 'Acme_B', 'Acme_C']), properties: rng() < 0.5 ? [{ name: 'Code' }] : undefined } } };
    default: {
      const declared = doc.meta.custom.psets;
      return declared.length ? { kind: 'meta.custom.removePset', opId, payload: { name: pick(rng, declared).name } } : undefined;
    }
  }
}
