/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IfcParser } from '@ifc-lite/parser';
import { applyRelMemberStrip, inverseRules } from './merged-inverse-claims.js';
import { MergedExporter } from './merged-exporter.js';
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
  /** The subset of `attributes` that are aggregates (SET/LIST/BAG). */
  aggregates: Set<string>;
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
      aggregates: new Set(),
      inverses: [],
    };
    let section: 'explicit' | 'inverse' | 'other' = 'explicit';
    for (const line of body.slice(headerEnd + 1).split('\n').map(l => l.trim())) {
      if (/^(INVERSE)$/.test(line)) section = 'inverse';
      else if (/^(DERIVE|WHERE|UNIQUE)$/.test(line)) section = 'other';
      else if (section === 'explicit' && /^\w+\s*:/.test(line)) {
        const [attribute, type] = line.split(/\s*:\s*/);
        entity.attributes.push(attribute);
        if (/^(OPTIONAL\s+)?(SET|LIST|BAG)\b/.test(type)) entity.aggregates.add(attribute);
      }
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

/** Every explicit attribute of `type`, inherited first, and whether it is an aggregate. */
function allAttributesOf(schema: Map<string, ExpressEntity>, type: string): Array<{ name: string; list: boolean }> {
  const entity = schema.get(type)!;
  return [
    ...(entity.supertype ? allAttributesOf(schema, entity.supertype.toUpperCase()) : []),
    ...entity.attributes.map(name => ({ name, list: entity.aggregates.has(name) })),
  ];
}

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
 * The single-valued relationship inverses the claim pass leaves alone, and
 * why. Each key is `${relType}.${attributeIndex}`.
 */
const NOT_CLAIMED: Record<'IFC2X3' | 'IFC4' | 'IFC4X3', string[]> = {
  IFC2X3: [],
  // `Corresponds` names a relationship from a relationship, and a merge never
  // unifies relationships, so no two models' boundaries can meet on one.
  IFC4: ['IFCRELSPACEBOUNDARY2NDLEVEL.10'],
  IFC4X3: ['IFCRELSPACEBOUNDARY2NDLEVEL.10'],
};

describe('the inverse rule table agrees with the EXPRESS schemas (#5774, #5923)', () => {
  for (const schemaName of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
    const schema = readExpress(EXPRESS[schemaName]);
    const expected = singleValuedRelInverses(schema);

    it(`${schemaName}: every rule names a single-valued inverse on its claimed attribute`, () => {
      expect(expected.size).toBeGreaterThan(0);
      for (const [relType, rules] of inverseRules(schemaName as IfcSchemaVersion)) {
        for (const rule of rules.filter(r => r.where === undefined)) {
          expect(expected.get(`${relType}.${rule.claimed}`), `${relType}.${rule.claimed}`).toBe(rule.inverse);
        }
      }
    });

    it(`${schemaName}: every single-valued relationship inverse is claimed or listed as not claimed`, () => {
      const claimed = new Set([...inverseRules(schemaName as IfcSchemaVersion)].flatMap(([relType, rules]) =>
        rules.filter(rule => rule.where === undefined).map(rule => `${relType}.${rule.claimed}`)));
      const missing = [...expected.keys()].filter(key => !claimed.has(key) && !NOT_CLAIMED[schemaName].includes(key));
      expect(missing).toEqual([]);
      // And no stale entry: each one still names a single-valued inverse the table does not cover.
      expect(NOT_CLAIMED[schemaName].filter(key => !expected.has(key) || claimed.has(key))).toEqual([]);
    });
  }

  it('a WHERE-rule row names a rule that bounds its relationship to one per object (IFC2X3 IfcObject.WR1)', () => {
    const rows = [...inverseRules('IFC2X3')].flatMap(([relType, rules]) => rules.filter(r => r.where).map(r => [relType, r] as const));
    expect(rows.map(([relType, r]) => `${relType}.${r.claimed} ${r.where}`)).toEqual(['IFCRELDEFINESBYTYPE.4 IfcObject.WR1']);
    const text = readFileSync(fileURLToPath(new URL('../../codegen/schemas/IFC2X3_TC1.exp', import.meta.url)), 'utf8');
    const object = /^ENTITY IfcObject$[\s\S]*?^END_ENTITY;/m.exec(text)![0];
    expect(object).toContain("WR1 : SIZEOF(QUERY(temp <* IsDefinedBy | 'IFC2X3.IFCRELDEFINESBYTYPE' IN TYPEOF(temp))) <= 1;");
    // IsDefinedBy is the inverse RelatedObjects (attribute 4) fills.
    expect(readExpress(EXPRESS.IFC2X3).get('IFCOBJECT')!.inverses.find(i => i.name === 'IsDefinedBy')).toMatchObject({ relType: 'IfcRelDefines', attribute: 'RelatedObjects' });
  });

  it('IFC2X3 bounds a property set to one IfcRelDefinesByProperties; IFC4 and IFC4X3 do not', () => {
    expect(singleValuedRelInverses(readExpress(EXPRESS.IFC2X3)).get('IFCRELDEFINESBYPROPERTIES.5')).toBe('PropertyDefinitionOf');
    for (const schemaName of ['IFC4', 'IFC4X3'] as const) {
      const pset = readExpress(EXPRESS[schemaName]).get('IFCPROPERTYSETDEFINITION')!;
      expect(pset.inverses.find(inverse => inverse.name === 'DefinesOccurrence')?.upper).toBeNull();
      expect(inverseRules(schemaName).has('IFCRELDEFINESBYPROPERTIES')).toBe(false);
    }
  });
});

/**
 * Every row, through a real merge (#5923): model A and model B each state the
 * row's relationship about one entity they share by GlobalId, with a partner
 * of their own. The merged file must name that entity on the claimed side of
 * one such relationship only. Built from the EXPRESS attribute list, so a row
 * with a wrong index or a missing row fails here, not just in the pin above.
 */
describe('every inverse rule keeps one relationship per GlobalId-unified entity (#5923)', () => {
  const guid = (label: string): string => (label + '0'.repeat(22)).slice(0, 22);
  const FILE_SCHEMA: Record<'IFC2X3' | 'IFC4' | 'IFC4X3', string> = { IFC2X3: 'IFC2X3', IFC4: 'IFC4', IFC4X3: 'IFC4X3_ADD2' };

  for (const schemaName of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
    const schema = readExpress(EXPRESS[schemaName]);
    for (const [relType, rules] of inverseRules(schemaName)) {
      for (const rule of rules) {
        it(`${schemaName} ${relType}: ${rule.inverse}`, async () => {
          const attributes = allAttributesOf(schema, relType);
          const line = (tag: string) => {
            const slots = attributes.map(({ list }, i) => {
              const ref = i === rule.claimed ? '#10' : i === rule.partner ? '#11' : null;
              if (i === 0) return `'${guid(`r${tag}`)}'`;
              if (ref === null) return '$';
              return list ? `(${ref})` : ref;
            });
            return `#20=${relType}(${slots.join(',')});`;
          };
          const lines = (tag: string) => [
            `#1=IFCPROJECT('${guid(`p${tag}`)}',$,'${tag}',$,$,$,$,$,$);`,
            `#10=IFCBUILDINGELEMENTPROXY('${guid('shared')}',$,'shared',$,$,$,$,$,$);`,
            `#11=IFCBUILDINGELEMENTPROXY('${guid(`own${tag}`)}',$,'own',$,$,$,$,$,$);`,
            line(tag),
          ];
          const parse = async (tag: string) => {
            const text = ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');", "FILE_NAME('m.ifc','',(''),(''),'','','');",
              `FILE_SCHEMA(('${FILE_SCHEMA[schemaName]}'));`, 'ENDSEC;', 'DATA;', ...lines(tag), 'ENDSEC;', 'END-ISO-10303-21;'].join('\n');
            return { id: tag, name: tag, dataStore: await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer) };
          };
          const out = new TextDecoder().decode(new MergedExporter([await parse('a'), await parse('b')]).export({ schema: schemaName }).content);
          const shared = Number(new RegExp(`^#(\\d+)=IFCBUILDINGELEMENTPROXY\\('${guid('shared')}'`, 'm').exec(out)![1]);
          const naming = [...out.matchAll(new RegExp(`^#\\d+=${relType}\\((.*)\\);$`, 'gm'))].filter(([, args]) => {
            const slot = args.match(/\([^)]*\)|'[^']*'|[^,]+/g)![rule.claimed];
            return [...slot.matchAll(/#(\d+)/g)].some(m => Number(m[1]) === shared);
          });
          expect(naming, out).toHaveLength(1);
        });
      }
    }
  }
});

/**
 * The rule table, as data, for the Rust twin (`rules_of` in
 * `rust/export/src/merged/single_parents.rs`): one row per schema, relationship
 * and rule, with the argument count and the claimed/partner shapes the EXPRESS
 * gives it. `rust/export/tests/merged_single_inverses.rs` merges one case per
 * row, so a Rust table that drifts from this one fails there. Regenerate with
 * `UPDATE_INVERSE_RULES=1`.
 */
describe('the inverse rule table fixture shared with Rust (#5923)', () => {
  const fixturePath = fileURLToPath(new URL('../../../rust/export/tests/fixtures/merged_inverse_rules.json', import.meta.url));

  it('matches inverseRules() and the EXPRESS attribute lists', () => {
    const rows = (['IFC2X3', 'IFC4', 'IFC4X3'] as const).flatMap(schemaName => {
      const schema = readExpress(EXPRESS[schemaName]);
      return [...inverseRules(schemaName)].sort(([a], [b]) => a.localeCompare(b)).flatMap(([relType, rules]) => {
        const attributes = allAttributesOf(schema, relType);
        return rules.map(rule => ({
          schema: schemaName,
          relType,
          inverse: rule.inverse,
          claimed: rule.claimed,
          partner: rule.partner,
          claimedList: attributes[rule.claimed].list,
          partnerList: attributes[rule.partner].list,
          arity: attributes.length,
          ...(rule.onePartner ? { onePartner: true } : {}),
          ...(rule.where ? { where: rule.where } : {}),
        }));
      });
    });
    const text = `${JSON.stringify({ rows }, null, 2)}\n`;
    if (process.env.UPDATE_INVERSE_RULES) writeFileSync(fixturePath, text);
    // NOT guarded by existsSync: a missing fixture means the Rust pin is not enforced.
    expect(readFileSync(fixturePath, 'utf8')).toBe(text);
  });
});
