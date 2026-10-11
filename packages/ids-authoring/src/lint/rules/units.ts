/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Numeric value rules: IDSL-VAL-008 (real equality) and IDSL-UNIT-001 (non-SI magnitude). */

import type { IDSBoundsConstraint, IDSConstraint } from '@ifc-lite/ids';
import { quickFix } from '../fix.js';
import type { Finding, SpecRule } from '../types.js';
import { at } from '../walk.js';
import { gated, single } from './util.js';
import { FLOAT_XSD, mapLiterals, siteLiterals, valueSites } from './value-sites.js';
import { rawSet } from './values.js';

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export const VAL_008: SpecRule = {
  code: 'IDSL-VAL-008',
  area: 'VAL',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'Exact match on a real number',
  rationale:
    'The value is an exact real number on a floating-point data type. IDS 1.0 compares reals with a small relative tolerance (1e-6, see the buildingSMART tolerance test cases), which absorbs rounding but not unit conversion or modelling tolerance: 2.4 does not match 2.4004. A range states the tolerance explicitly. Tolerance handling is under discussion for IDS 1.1 (IDS issue #418).',
  references: ['https://github.com/buildingSMART/IDS/issues/418'],
  example: '<property dataType="IFCLENGTHMEASURE">…<value><simpleValue>2.4</simpleValue></value></property>',
  check(spec, { ctx }) {
    const out: Finding[] = [];
    for (const site of valueSites(ctx, spec)) {
      if (site.field !== 'property.value' || !site.xsd.some((x) => FLOAT_XSD.has(x))) continue;
      const nums = siteLiterals(site.constraint).filter((v) => NUMBER.test(v.trim()));
      if (!nums.length || site.constraint.type === 'bounds') continue;
      out.push({ ...at(site.view, site.field), message: `exact match on the real ${nums.join(', ')} (${site.dataType}); consider a range` });
    }
    return out;
  },
};

interface Quantity {
  kind: 'length' | 'area' | 'volume';
  /** Smallest magnitude that suggests a non-SI unit. */
  threshold: number;
  factor: number;
  unit: string;
}

const LENGTH: Quantity = { kind: 'length', threshold: 1000, factor: 1e3, unit: 'mm' };
const SHORT_LENGTH: Quantity = { ...LENGTH, threshold: 100 };
const AREA: Quantity = { kind: 'area', threshold: 1e6, factor: 1e6, unit: 'mm²' };
const VOLUME: Quantity = { kind: 'volume', threshold: 1e9, factor: 1e9, unit: 'mm³' };

const DIMENSION_NAME = /(Height|Width|Depth|Thickness|Diameter|Radius)$/;

function quantityOf(dataType: string | undefined, baseName: string | undefined): Quantity | undefined {
  switch (dataType) {
    case 'IFCLENGTHMEASURE':
    case 'IFCPOSITIVELENGTHMEASURE':
    case 'IFCNONNEGATIVELENGTHMEASURE':
      return baseName && DIMENSION_NAME.test(baseName) ? SHORT_LENGTH : LENGTH;
    case 'IFCAREAMEASURE':
      return AREA;
    case 'IFCVOLUMEMEASURE':
      return VOLUME;
    default:
      return undefined;
  }
}

const BOUND_KEYS = ['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'] as const;

function magnitudes(c: IDSConstraint): number[] {
  if (c.type === 'bounds') return BOUND_KEYS.map((k) => c[k]).filter((x): x is number => x !== undefined);
  return siteLiterals(c).filter((v) => NUMBER.test(v.trim())).map(Number);
}

function scaled(n: number, factor: number): number {
  return Number((n / factor).toPrecision(12));
}

function convert(c: IDSConstraint, factor: number): IDSConstraint {
  if (c.type !== 'bounds') return mapLiterals(c, (v) => (NUMBER.test(v.trim()) ? String(scaled(Number(v), factor)) : v));
  const next: IDSBoundsConstraint = { ...c };
  for (const k of BOUND_KEYS) if (c[k] !== undefined) next[k] = scaled(c[k] as number, factor);
  return next;
}

export const UNIT_001: SpecRule = {
  code: 'IDSL-UNIT-001',
  area: 'UNIT',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Magnitude suggests a non-SI unit',
  rationale:
    'IDS values are in SI units: metres, square metres, cubic metres. A door height of 2400 or a wall thickness of 240 is almost certainly in millimetres and will never match a model, which stores 2.4 and 0.24 in IDS terms. Thresholds: lengths from 1000 (from 100 for Height, Width, Depth, Thickness, Diameter, Radius), areas from 1e6, volumes from 1e9.',
  fix: 'Convert the value from millimetres to SI.',
  example: '<property dataType="IFCLENGTHMEASURE">…<baseName><simpleValue>Height</simpleValue></baseName><value><simpleValue>2400</simpleValue></value></property>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const site of valueSites(ctx, spec)) {
      if (site.field !== 'property.value' || site.view.facet.type !== 'property') continue;
      const q = quantityOf(site.dataType, single(site.view.facet.baseName));
      if (!q) continue;
      const big = magnitudes(site.constraint).filter((n) => Math.abs(n) >= q.threshold);
      if (!big.length) continue;
      const fix = quickFix(`Convert from ${q.unit}`, this.code, site.view.facetId, q.unit, [rawSet(site.view.facetId, site.field, convert(site.constraint, q.factor))]);
      out.push({
        ...at(site.view, site.field),
        message: `${big.join(', ')} as a ${q.kind} in SI units is implausible; probably ${q.unit} (= ${big.map((n) => scaled(n, q.factor)).join(', ')})`,
        fixes: gated(doc, ctx, [fix]),
      });
    }
    return out;
  },
};
