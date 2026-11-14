/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compact encoding of a generated `SchemaRegistry`.
 *
 * WHY. The registry used to be emitted as one object literal per schema:
 * 843 KB (IFC4), 961 KB (IFC4X3) and 669 KB (IFC2X3) of minified JavaScript
 * that every bundle carrying it compiles and evaluates when it loads, whether
 * or not it asks a question of that schema. The browser viewer's parser
 * worker carries all three before it can accept a parse, and so does the main
 * thread's eager JS. Most of the bytes are repetition: every entity spells out
 * its inherited attributes again (`allAttributes`) and its ancestry again
 * (`inheritanceChain`). The encoded form names each string once, each distinct
 * attribute once, and records "derived from the parent" where that is exactly
 * what the full lists would say. The generated module keeps it as one string
 * and decodes it the first time anything asks (`getSchemaRegistry()`), so a
 * bundle that never asks pays for scanning a string literal only.
 *
 * EXACTNESS. The decoded registry is the same object graph the literal
 * described: the same keys in the same order (a missing `parent` stays
 * missing, `arrayBounds` appears only where it did), fresh objects for every
 * attribute occurrence, the same arrays. {@link encodeSchemaRegistry} proves
 * that for every registry it encodes: it decodes its own output with
 * {@link decodeSchemaRegistry} and compares it with the input, and lists an
 * entity's attributes or ancestry explicitly wherever "derived" would differ.
 * `SCHEMA_REGISTRY_DECODER_SOURCE` is the same decoder as emitted TypeScript;
 * `schema-registry-codec.test.ts` decodes the committed generated files
 * through it and compares them with {@link buildSchemaRegistry}.
 */

import type { ExpressSchema, EntityDefinition, AttributeDefinition } from './express-parser.js';
import { getAllAttributes, getInheritanceChain } from './express-parser.js';

export interface RegistryAttribute {
  name: string;
  type: string;
  optional: boolean;
  isArray: boolean;
  isList: boolean;
  isSet: boolean;
  arrayBounds?: [number, number];
}

export interface RegistryEntity {
  name: string;
  isAbstract: boolean;
  parent?: string;
  attributes: RegistryAttribute[];
  allAttributes?: RegistryAttribute[];
  inheritanceChain?: string[];
}

export interface RegistryData {
  name: string;
  entities: Record<string, RegistryEntity>;
  types: Record<string, string>;
  enums: Record<string, string[]>;
  selects: Record<string, string[]>;
}

/** One entity row: name, abstract (0/1), parent (-1 = none), own attribute
 *  ids, then all attribute ids or 0 (= parent's ++ own), then the ancestry as
 *  string ids or 0 (= parent's ++ name). */
export type EncodedEntityRow = [number, number, number, number[], number[] | 0, number[] | 0];

export interface EncodedSchemaRegistry {
  /** Schema name. */
  n: string;
  /** String table. */
  s: string[];
  /** Attribute table: name id, type id, flags (1 optional, 2 array, 4 list, 8 set), then bounds if any. */
  a: number[][];
  /** Entities in registry order. */
  e: EncodedEntityRow[];
  /** types, enums, selects: key id and value id(s), in registry order. */
  t: [number, number][];
  en: [number, number[]][];
  se: [number, number[]][];
}

function toAttribute(attr: AttributeDefinition): RegistryAttribute {
  const out: RegistryAttribute = {
    name: attr.name,
    type: attr.type,
    optional: attr.optional,
    isArray: attr.isArray,
    isList: attr.isList,
    isSet: attr.isSet,
  };
  if (attr.arrayBounds) out.arrayBounds = [attr.arrayBounds[0], attr.arrayBounds[1]];
  return out;
}

function toEntity(entity: EntityDefinition, schema: ExpressSchema): RegistryEntity {
  const out: RegistryEntity = { name: entity.name, isAbstract: entity.isAbstract } as RegistryEntity;
  if (entity.supertype) out.parent = entity.supertype;
  out.attributes = entity.attributes.map(toAttribute);
  out.allAttributes = getAllAttributes(entity, schema).map(toAttribute);
  out.inheritanceChain = getInheritanceChain(entity, schema);
  return out;
}

/** The registry a schema generates, as the object the generated module decodes to. */
export function buildSchemaRegistry(schema: ExpressSchema): RegistryData {
  const entities: Record<string, RegistryEntity> = {};
  for (const entity of schema.entities) entities[entity.name] = toEntity(entity, schema);
  const types: Record<string, string> = {};
  for (const type of schema.types) types[type.name] = type.underlyingType.replace(/\n/g, ' ');
  const enums: Record<string, string[]> = {};
  for (const enumDef of schema.enums) enums[enumDef.name] = [...enumDef.values];
  const selects: Record<string, string[]> = {};
  for (const select of schema.selects) selects[select.name] = [...select.types];
  return { name: schema.name, entities, types, enums, selects };
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Decoder. Kept as plain, dependency-free code so the generated module can
 * carry the same algorithm as {@link SCHEMA_REGISTRY_DECODER_SOURCE}.
 */
export function decodeSchemaRegistry(d: EncodedSchemaRegistry): RegistryData {
  const s = d.s;
  const attribute = (i: number): RegistryAttribute => {
    const t = d.a[i];
    const a: RegistryAttribute = { name: s[t[0]], type: s[t[1]], optional: (t[2] & 1) !== 0, isArray: (t[2] & 2) !== 0, isList: (t[2] & 4) !== 0, isSet: (t[2] & 8) !== 0 };
    if (t.length > 3) a.arrayBounds = [t[3], t[4]];
    return a;
  };
  const copy = (a: RegistryAttribute): RegistryAttribute => {
    const c: RegistryAttribute = { ...a };
    if (a.arrayBounds) c.arrayBounds = [a.arrayBounds[0], a.arrayBounds[1]];
    return c;
  };
  const entities: Record<string, RegistryEntity> = {};
  const rows: Record<string, EncodedEntityRow> = {};
  for (const row of d.e) {
    const name = s[row[0]];
    const entity: RegistryEntity = row[2] >= 0
      ? { name, isAbstract: row[1] === 1, parent: s[row[2]], attributes: row[3].map(attribute), allAttributes: [], inheritanceChain: [] }
      : { name, isAbstract: row[1] === 1, attributes: row[3].map(attribute), allAttributes: [], inheritanceChain: [] };
    entities[name] = entity;
    rows[name] = row;
  }
  const done = new Set<string>();
  const resolve = (name: string, visiting: Set<string>): RegistryEntity => {
    const entity = entities[name];
    if (done.has(name)) return entity;
    visiting.add(name);
    const row = rows[name];
    const parentName = row[2] >= 0 ? s[row[2]] : undefined;
    const parent = (row[4] === 0 || row[5] === 0) && parentName !== undefined && hasOwn(entities, parentName) && !visiting.has(parentName)
      ? resolve(parentName, visiting)
      : undefined;
    entity.allAttributes = row[4] === 0
      ? [...(parent?.allAttributes ?? []).map(copy), ...row[3].map(attribute)]
      : row[4].map(attribute);
    entity.inheritanceChain = row[5] === 0
      ? [...(parent?.inheritanceChain ?? []), name]
      : row[5].map((i) => s[i]);
    done.add(name);
    return entity;
  };
  for (const name of Object.keys(entities)) resolve(name, new Set());
  const types: Record<string, string> = {};
  for (const [k, v] of d.t) types[s[k]] = s[v];
  const enums: Record<string, string[]> = {};
  for (const [k, v] of d.en) enums[s[k]] = v.map((i) => s[i]);
  const selects: Record<string, string[]> = {};
  for (const [k, v] of d.se) selects[s[k]] = v.map((i) => s[i]);
  return { name: d.n, entities, types, enums, selects };
}

/** Structural identity: same keys in the same order, same values, `undefined`-valued keys kept. */
export function registryFingerprint(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v === undefined ? { __undefined__: true } : v));
}

/**
 * Encode a registry. Throws unless the encoding decodes to exactly `reg`.
 */
export function encodeSchemaRegistry(reg: RegistryData): EncodedSchemaRegistry {
  const strings: string[] = [];
  const stringIds = new Map<string, number>();
  const str = (x: string): number => {
    let i = stringIds.get(x);
    if (i === undefined) { i = strings.length; strings.push(x); stringIds.set(x, i); }
    return i;
  };
  const attrs: number[][] = [];
  const attrIds = new Map<string, number>();
  const attr = (a: RegistryAttribute): number => {
    const keys = Object.keys(a).join(',');
    const plain = 'name,type,optional,isArray,isList,isSet';
    if (keys !== plain && keys !== `${plain},arrayBounds`) throw new Error(`schema registry ${reg.name}: unexpected attribute keys ${keys}`);
    const t = [str(a.name), str(a.type), (a.optional ? 1 : 0) | (a.isArray ? 2 : 0) | (a.isList ? 4 : 0) | (a.isSet ? 8 : 0)];
    if (a.arrayBounds) t.push(a.arrayBounds[0], a.arrayBounds[1]);
    const key = t.join(',');
    let i = attrIds.get(key);
    if (i === undefined) { i = attrs.length; attrs.push(t); attrIds.set(key, i); }
    return i;
  };
  const rowFor = (key: string, derived: boolean): EncodedEntityRow => {
    const e = reg.entities[key];
    const keys = Object.keys(e).join(',');
    const want = hasOwn(e, 'parent')
      ? 'name,isAbstract,parent,attributes,allAttributes,inheritanceChain'
      : 'name,isAbstract,attributes,allAttributes,inheritanceChain';
    if (keys !== want || e.name !== key || (hasOwn(e, 'parent') && typeof e.parent !== 'string')) {
      throw new Error(`schema registry ${reg.name}: entity ${key} has keys ${keys}`);
    }
    return [
      str(key),
      e.isAbstract ? 1 : 0,
      e.parent !== undefined ? str(e.parent) : -1,
      e.attributes.map(attr),
      derived ? 0 : (e.allAttributes ?? []).map(attr),
      derived ? 0 : (e.inheritanceChain ?? []).map(str),
    ];
  };
  const keys = Object.keys(reg.entities);
  const encode = (explicit: ReadonlySet<string>): EncodedSchemaRegistry => ({
    n: reg.name,
    s: strings,
    a: attrs,
    e: keys.map((k) => rowFor(k, !explicit.has(k))),
    t: Object.entries(reg.types).map(([k, v]) => [str(k), str(v)]),
    en: Object.entries(reg.enums).map(([k, v]) => [str(k), v.map(str)]),
    se: Object.entries(reg.selects).map(([k, v]) => [str(k), v.map(str)]),
  });
  // Derive everything first; list explicitly whatever that gets wrong, and
  // repeat (an explicit parent can change what its children derive).
  const explicit = new Set<string>();
  for (let pass = 0; pass <= keys.length; pass++) {
    const encoded = encode(explicit);
    const decoded = decodeSchemaRegistry(JSON.parse(JSON.stringify(encoded)) as EncodedSchemaRegistry);
    if (registryFingerprint(decoded) === registryFingerprint(reg)) return encoded;
    let grew = false;
    for (const k of keys) {
      if (!explicit.has(k) && registryFingerprint(decoded.entities[k]) !== registryFingerprint(reg.entities[k])) {
        explicit.add(k);
        grew = true;
      }
    }
    if (!grew) break;
  }
  throw new Error(`schema registry ${reg.name}: compact encoding does not round-trip`);
}

/**
 * The decoder as emitted into each generated `schema-registry.ts` (the same
 * algorithm as {@link decodeSchemaRegistry}, typed against that module's own
 * `SchemaRegistry` interfaces). Contains no backtick.
 */
export const SCHEMA_REGISTRY_DECODER_SOURCE = `type EncodedEntityRow = [number, number, number, number[], number[] | 0, number[] | 0];

interface EncodedSchemaRegistry {
  n: string;
  s: string[];
  a: number[][];
  e: EncodedEntityRow[];
  t: [number, number][];
  en: [number, number[]][];
  se: [number, number[]][];
}

function decodeSchemaRegistry(d: EncodedSchemaRegistry): SchemaRegistry {
  const s = d.s;
  const attribute = (i: number): AttributeMetadata => {
    const t = d.a[i];
    const a: AttributeMetadata = { name: s[t[0]], type: s[t[1]], optional: (t[2] & 1) !== 0, isArray: (t[2] & 2) !== 0, isList: (t[2] & 4) !== 0, isSet: (t[2] & 8) !== 0 };
    if (t.length > 3) a.arrayBounds = [t[3], t[4]];
    return a;
  };
  const copy = (a: AttributeMetadata): AttributeMetadata => {
    const c: AttributeMetadata = { ...a };
    if (a.arrayBounds) c.arrayBounds = [a.arrayBounds[0], a.arrayBounds[1]];
    return c;
  };
  const entities: Record<string, EntityMetadata> = {};
  const rows: Record<string, EncodedEntityRow> = {};
  for (const row of d.e) {
    const name = s[row[0]];
    const entity: EntityMetadata = row[2] >= 0
      ? { name, isAbstract: row[1] === 1, parent: s[row[2]], attributes: row[3].map(attribute), allAttributes: [], inheritanceChain: [] }
      : { name, isAbstract: row[1] === 1, attributes: row[3].map(attribute), allAttributes: [], inheritanceChain: [] };
    entities[name] = entity;
    rows[name] = row;
  }
  const done = new Set<string>();
  const resolve = (name: string, visiting: Set<string>): EntityMetadata => {
    const entity = entities[name];
    if (done.has(name)) return entity;
    visiting.add(name);
    const row = rows[name];
    const parentName = row[2] >= 0 ? s[row[2]] : undefined;
    const parent = (row[4] === 0 || row[5] === 0) && parentName !== undefined && Object.prototype.hasOwnProperty.call(entities, parentName) && !visiting.has(parentName)
      ? resolve(parentName, visiting)
      : undefined;
    entity.allAttributes = row[4] === 0
      ? [...(parent?.allAttributes ?? []).map(copy), ...row[3].map(attribute)]
      : row[4].map(attribute);
    entity.inheritanceChain = row[5] === 0
      ? [...(parent?.inheritanceChain ?? []), name]
      : row[5].map((i) => s[i]);
    done.add(name);
    return entity;
  };
  for (const name of Object.keys(entities)) resolve(name, new Set());
  const types: Record<string, string> = {};
  for (const [k, v] of d.t) types[s[k]] = s[v];
  const enums: Record<string, string[]> = {};
  for (const [k, v] of d.en) enums[s[k]] = v.map((i) => s[i]);
  const selects: Record<string, string[]> = {};
  for (const [k, v] of d.se) selects[s[k]] = v.map((i) => s[i]);
  return { name: d.n, entities, types, enums, selects };
}
`;

/**
 * Every concrete (non-abstract) `IfcRelationship` subtype of a registry, as an
 * upper-cased STEP keyword, in registry order: the walk the parser's
 * relationship gate used to run over the decoded registry at load time
 * (`packages/parser/src/relationship-schema-slots.ts`), done once at
 * generation time instead. The parser's tests keep that walk as the oracle
 * for the emitted list.
 */
export function concreteRelationshipTypes(reg: RegistryData): string[] {
  const isRelationship = (name: string): boolean => {
    let cursor: RegistryEntity | undefined = reg.entities[name];
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.name)) {
      if (cursor.name === 'IfcRelationship') return true;
      seen.add(cursor.name);
      cursor = cursor.parent ? reg.entities[cursor.parent] : undefined;
    }
    return false;
  };
  const out: string[] = [];
  for (const [name, meta] of Object.entries(reg.entities)) {
    if (meta.isAbstract) continue;
    if (isRelationship(name)) out.push(name.toUpperCase());
  }
  return out;
}
