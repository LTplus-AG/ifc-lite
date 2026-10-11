/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Value sites: the constraint fields that hold VALUES (not names), with
 * the data type they are compared under where it is known.
 */

import type { IDSConstraint, IDSPropertyFacet } from '@ifc-lite/ids';
import type { FacetFieldName } from '../../document/fields.js';
import { getField } from '../../document/fields.js';
import { inheritanceChain } from '../../gate/context.js';
import type { FacetView, LintContext, SpecView } from '../types.js';
import { expectedDataType } from './pset.js';
import { applicabilityEntityNames, single, tables } from './util.js';

export interface ValueSite {
  view: FacetView;
  field: FacetFieldName;
  constraint: IDSConstraint;
  /** Upper-case IFC data type (explicit, else from the standard property). */
  dataType?: string;
  /** XSD backing type of the data type, or the XSD types an attribute slot accepts. */
  xsd: readonly string[];
  /** Whether `dataType` was written on the facet. */
  explicit: boolean;
}

const VALUE_FIELDS: readonly FacetFieldName[] = ['property.value', 'attribute.value', 'classification.value', 'classification.system', 'material.value'];

function propertyType(ctx: LintContext, spec: SpecView, facet: IDSPropertyFacet): { dataType?: string; explicit: boolean } {
  const explicit = single(facet.dataType)?.toUpperCase();
  if (explicit) return { dataType: explicit, explicit: true };
  const psetName = single(facet.propertySet);
  const name = single(facet.baseName);
  if (!psetName || !name) return { explicit: false };
  const types = new Set(
    spec.versions.map((v) => expectedDataType(tables(ctx, v).psets.get(psetName)?.properties.find((p) => p.name === name))?.toUpperCase()),
  );
  const [only] = types;
  return { dataType: types.size === 1 ? only : undefined, explicit: false };
}

function attributeXsd(ctx: LintContext, spec: SpecView, name: string | undefined): string[] {
  const entities = applicabilityEntityNames(spec);
  if (!name || entities.length !== 1) return [];
  const sets = spec.versions.map((v) => {
    const meta = ctx.attributes[v].get(name.toLowerCase());
    if (!meta) return [];
    const chain = inheritanceChain(tables(ctx, v), entities[0]).map((e) => e.name.toUpperCase());
    const key = chain.find((e) => meta.xsdTypesByEntity[e]);
    return key ? [...meta.xsdTypesByEntity[key]] : [];
  });
  const [first, ...rest] = sets;
  return first && rest.every((s) => s.join() === first.join()) ? first : [];
}

export function valueSites(ctx: LintContext, spec: SpecView): ValueSite[] {
  const out: ValueSite[] = [];
  for (const view of [...spec.applicability, ...spec.requirements]) {
    for (const field of VALUE_FIELDS) {
      const constraint = getField(view.facet, field);
      if (!constraint) continue;
      const f = view.facet;
      if (f.type === 'property') {
        const { dataType, explicit } = propertyType(ctx, spec, f);
        const backing = dataType ? tables(ctx, spec.versions[0]).dataTypes.get(dataType)?.backingType : undefined;
        out.push({ view, field, constraint, dataType, explicit, xsd: backing ? [backing] : [] });
      } else if (f.type === 'attribute') {
        out.push({ view, field, constraint, explicit: false, xsd: attributeXsd(ctx, spec, single(f.name)) });
      } else {
        out.push({ view, field, constraint, explicit: false, xsd: [] });
      }
    }
  }
  return out;
}

export const NUMERIC_XSD = new Set(['xs:double', 'xs:integer', 'xs:decimal', 'xs:float']);
export const FLOAT_XSD = new Set(['xs:double', 'xs:decimal', 'xs:float']);

/** The XSD base a constraint declares, if any. */
export function baseOf(c: IDSConstraint): string | undefined {
  return c.type === 'simpleValue' ? undefined : c.base;
}

/** Literal values of a site (simpleValue, or each enumeration value). */
export function siteLiterals(c: IDSConstraint): string[] {
  if (c.type === 'simpleValue') return [c.value];
  if (c.type === 'enumeration') return [...c.values];
  return [];
}

/** A copy of `c` with its literals mapped (simpleValue / enumeration only). */
export function mapLiterals(c: IDSConstraint, fn: (v: string) => string): IDSConstraint {
  if (c.type === 'simpleValue') return { ...c, value: fn(c.value) };
  if (c.type === 'enumeration') return { ...c, values: c.values.map(fn) };
  return c;
}
