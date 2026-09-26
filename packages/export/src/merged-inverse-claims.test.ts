/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyRelMemberStrip, inverseRules } from './merged-inverse-claims.js';
import type { IfcSchemaVersion } from './schema-converter.js';

describe('applyRelMemberStrip', () => {
  const line = "#10=IFCRELAGGREGATES('guid',#2,$,$,#5,(#6,#7));";

  it('returns the line unchanged when the id has no strip entry', () => {
    expect(applyRelMemberStrip(line, 10, new Map())).toBe(line);
  });

  it('narrows the RelatedObjects list to the members not stripped', () => {
    const strip = new Map([[10, new Set([6])]]);
    expect(applyRelMemberStrip(line, 10, strip)).toBe(
      "#10=IFCRELAGGREGATES('guid',#2,$,$,#5,(#7));",
    );
  });

  it('returns null, not the unfiltered line, when the filter would withhold it', () => {
    // Degenerate input: the strip set reaches a single-valued ref (here the
    // RelatingObject, #5, in a self-aggregating line). The filter answers
    // null; passing the original bytes through instead would re-emit the
    // duplicate membership the strip exists to remove.
    const selfLine = "#10=IFCRELAGGREGATES('guid',#2,$,$,#5,(#5,#6));";
    const strip = new Map([[10, new Set([5])]]);
    expect(applyRelMemberStrip(selfLine, 10, strip)).toBeNull();
  });
});

/** The parts of an EXPRESS schema the rule table depends on. */
interface ExpressEntity {
  supertype: string | null;
  abstract: boolean;
  /** Explicit attributes declared here (not inherited, not redeclared). */
  attributes: string[];
  inverses: Array<{ name: string; upper: number | null; relType: string; attribute: string }>;
}

/** Read the entity blocks of an EXPRESS `.exp` file. */
function readExpress(file: string): Map<string, ExpressEntity> {
  const text = readFileSync(fileURLToPath(new URL(`../../codegen/schemas/${file}`, import.meta.url)), 'utf8');
  const entities = new Map<string, ExpressEntity>();
  for (const [, name, body] of text.matchAll(/^ENTITY (\w+)([\s\S]*?)^END_ENTITY;/gm)) {
    const headerEnd = body.indexOf(';');
    const header = body.slice(0, headerEnd);
    const entity: ExpressEntity = {
      supertype: /SUBTYPE OF \((\w+)\)/.exec(header)?.[1] ?? null,
      abstract: /ABSTRACT SUPERTYPE/.test(header),
      attributes: [],
      inverses: [],
    };
    let section: 'explicit' | 'inverse' | 'other' = 'explicit';
    for (const line of body.slice(headerEnd + 1).split('\n').map(l => l.trim())) {
      if (/^(INVERSE)$/.test(line)) section = 'inverse';
      else if (/^(DERIVE|WHERE|UNIQUE)$/.test(line)) section = 'other';
      else if (section === 'explicit' && /^\w+\s*:/.test(line)) entity.attributes.push(line.split(/\s*:/)[0]);
      else if (section === 'inverse') {
        const m = /^(\w+)\s*:\s*(?:(?:SET|BAG)\s*\[\d+:(\?|\d+)\]\s*OF\s+)?(\w+)\s+FOR\s+(\w+);/.exec(line);
        if (m) entity.inverses.push({ name: m[1], upper: m[2] === undefined ? 1 : m[2] === '?' ? null : Number(m[2]), relType: m[3], attribute: m[4] });
      }
    }
    entities.set(name.toUpperCase(), entity);
  }
  return entities;
}

const EXPRESS: Record<'IFC2X3' | 'IFC4' | 'IFC4X3', string> = {
  IFC2X3: 'IFC2X3_TC1.exp',
  IFC4: 'IFC4_ADD2_TC1.exp',
  IFC4X3: 'IFC4X3.exp',
};

/** `${relType}.${attributeIndex}` for every single-valued inverse a relationship fills, with the inverse's name. */
function singleValuedRelInverses(schema: Map<string, ExpressEntity>): Map<string, string> {
  const allAttributes = (type: string): string[] => {
    const entity = schema.get(type)!;
    return [...(entity.supertype ? allAttributes(entity.supertype.toUpperCase()) : []), ...entity.attributes];
  };
  const isA = (type: string, ancestor: string): boolean =>
    type === ancestor || (schema.get(type)?.supertype ? isA(schema.get(type)!.supertype!.toUpperCase(), ancestor) : false);
  const out = new Map<string, string>();
  for (const entity of schema.values()) {
    for (const inverse of entity.inverses) {
      const declared = inverse.relType.toUpperCase();
      if (inverse.upper !== 1 || !isA(declared, 'IFCRELATIONSHIP')) continue;
      // The inverse is declared against the rel's supertype; every instantiable subtype fills it.
      for (const [type, candidate] of schema) {
        if (candidate.abstract || !isA(type, declared)) continue;
        out.set(`${type}.${allAttributes(type).indexOf(inverse.attribute)}`, inverse.name);
      }
    }
  }
  return out;
}

/**
 * Single-valued relationship inverses the claim pass does not keep to one yet
 * (#5923 widens the table). Each key is `${relType}.${attributeIndex}`.
 */
const NOT_CLAIMED_ANY = [
  'IFCRELCONTAINEDINSPATIALSTRUCTURE.4', 'IFCRELCOVERSSPACES.5', 'IFCRELCOVERSBLDGELEMENTS.5',
  'IFCRELFLOWCONTROLELEMENTS.4', 'IFCRELFLOWCONTROLELEMENTS.5', 'IFCRELFILLSELEMENT.5', 'IFCRELPROJECTSELEMENT.5',
  'IFCRELVOIDSELEMENT.5', 'IFCRELCONNECTSPORTTOELEMENT.4', 'IFCRELCONNECTSPORTS.4', 'IFCRELCONNECTSPORTS.5',
  'IFCRELCONNECTSSTRUCTURALACTIVITY.5', 'IFCRELSERVICESBUILDINGS.4', 'IFCRELDEFINESBYTYPE.5',
];
const NOT_CLAIMED: Record<'IFC2X3' | 'IFC4' | 'IFC4X3', string[]> = {
  IFC2X3: [...NOT_CLAIMED_ANY, 'IFCRELASSIGNSTOGROUP.6', 'IFCRELASSIGNSTASKS.7'],
  IFC4: [...NOT_CLAIMED_ANY, 'IFCRELDEFINESBYTYPE.4', 'IFCRELDEFINESBYOBJECT.4', 'IFCRELDECLARES.5', 'IFCRELSPACEBOUNDARY2NDLEVEL.10'],
  IFC4X3: [...NOT_CLAIMED_ANY, 'IFCRELDEFINESBYTYPE.4', 'IFCRELDEFINESBYOBJECT.4', 'IFCRELDECLARES.5', 'IFCRELSPACEBOUNDARY2NDLEVEL.10', 'IFCRELADHERESTOELEMENT.5'],
};

describe('the inverse rule table agrees with the EXPRESS schemas (#5774)', () => {
  for (const schemaName of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
    const schema = readExpress(EXPRESS[schemaName]);
    const expected = singleValuedRelInverses(schema);

    it(`${schemaName}: every rule names a single-valued inverse on its claimed attribute`, () => {
      expect(expected.size).toBeGreaterThan(0);
      for (const [relType, rules] of inverseRules(schemaName as IfcSchemaVersion)) {
        for (const rule of rules) expect(expected.get(`${relType}.${rule.claimed}`), `${relType}.${rule.claimed}`).toBe(rule.inverse);
      }
    });

    it(`${schemaName}: every single-valued relationship inverse is claimed or listed as not claimed`, () => {
      const claimed = new Set([...inverseRules(schemaName as IfcSchemaVersion)].flatMap(([relType, rules]) => rules.map(rule => `${relType}.${rule.claimed}`)));
      const missing = [...expected.keys()].filter(key => !claimed.has(key) && !NOT_CLAIMED[schemaName].includes(key));
      expect(missing).toEqual([]);
      // And no stale entry: each one still names a single-valued inverse the table does not cover.
      expect(NOT_CLAIMED[schemaName].filter(key => !expected.has(key) || claimed.has(key))).toEqual([]);
    });
  }

  it('IFC2X3 bounds a property set to one IfcRelDefinesByProperties; IFC4 and IFC4X3 do not', () => {
    expect(singleValuedRelInverses(readExpress(EXPRESS.IFC2X3)).get('IFCRELDEFINESBYPROPERTIES.5')).toBe('PropertyDefinitionOf');
    for (const schemaName of ['IFC4', 'IFC4X3'] as const) {
      const pset = readExpress(EXPRESS[schemaName]).get('IFCPROPERTYSETDEFINITION')!;
      expect(pset.inverses.find(inverse => inverse.name === 'DefinesOccurrence')?.upper).toBeNull();
      expect(inverseRules(schemaName).has('IFCRELDEFINESBYPROPERTIES')).toBe(false);
    }
  });
});
