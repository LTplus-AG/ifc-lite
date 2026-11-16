/* SPDX-License-Identifier: MPL-2.0 */
/**
 * What the structural conversion prepasses (#9668) share: the schema pair they
 * run for, memoized reads of source records, subtype tests, and the property-set
 * carrier some of them write into the target file and read back from the source.
 */
import { deterministicGlobalId, getCanonicalEntityName, getSchemaRegistryForVersion, type IfcDataStore } from '@ifc-lite/parser';
import { listItems } from './schema-converter-structural-axes.js';
import { refId } from './schema-ifc2x3-records.js';
import { decodeRange } from './source-ref-bounds.js';
import { readStepSlots } from './step-argument-parser.js';

export type ConversionMode = 'upgrade' | 'downgrade' | null;

/** IFC2X3 -> IFC4 is an upgrade, IFC4 -> IFC2X3 a downgrade; the prepasses run for nothing else. */
export const conversionMode = (from: string, to: string): ConversionMode =>
  from === 'IFC2X3' && to === 'IFC4' ? 'upgrade' : from === 'IFC4' && to === 'IFC2X3' ? 'downgrade' : null;

/** A target record body, `null` for a source record the target leaves out, and what the change loses or moves. */
export interface StructuralRewrite { readonly body: string | null; readonly losses: readonly string[] }

const SUBTYPES = new Map<string, boolean>();
/** Whether `keyword` names a subtype of `parent` in `schema`, memoized per triple. */
export function isSubtype(schema: 'IFC2X3' | 'IFC4', keyword: string | undefined, parent: string): boolean {
  if (!keyword) return false;
  const key = `${schema} ${keyword} ${parent}`;
  let known = SUBTYPES.get(key);
  if (known === undefined) {
    const registry = getSchemaRegistryForVersion(schema);
    const name = getCanonicalEntityName(registry, keyword);
    known = !!name && registry.entities[name]?.inheritanceChain?.includes(parent) === true;
    SUBTYPES.set(key, known);
  }
  return known;
}

/** Source records read by id, each decoded once. Lives only for one prepass. */
export class SourceRecords {
  private readonly cache = new Map<number, readonly string[] | undefined>();
  constructor(private readonly store: IfcDataStore) {}

  // @raw-entity-enumeration-ok conversion prepass is enabled only for an unedited full-source export
  ids(type: string): readonly number[] { return this.store.entityIndex.byType.get(type) ?? []; }

  type(id: number | null): string | undefined {
    // @raw-entity-enumeration-ok same unedited source-only prepass
    return id === null ? undefined : this.store.entityIndex.byId.get(id)?.type.toUpperCase();
  }

  slots(id: number | null): readonly string[] | undefined {
    if (id === null) return undefined;
    if (!this.cache.has(id)) {
      // @raw-entity-enumeration-ok same unedited source-only prepass
      const entry = this.store.entityIndex.byId.get(id);
      this.cache.set(id, entry ? readStepSlots(decodeRange(this.store.source, entry.byteOffset, entry.byteOffset + entry.byteLength))?.slots : undefined);
    }
    return this.cache.get(id);
  }
}

/** The text of a STEP string token, or null. Only compared with fixed names here, so escapes need no decoding. */
export const stepString = (token: string | undefined): string | null => /^\s*'(.*)'\s*$/s.exec(token ?? '')?.[1] ?? null;

/** A property set attached by an IfcRelDefinesByProperties, read from the source. */
export interface CarrierSet {
  readonly rel: number;
  readonly pset: number;
  readonly related: readonly number[];
  /** Property name -> its id. */
  readonly props: ReadonlyMap<string, number>;
  /** Whether the set and each of its properties are named only by this relationship and this set. */
  readonly exclusive: boolean;
}

/** Every property set named `name` in the source, with what it relates to. */
export function readCarrierSets(source: SourceRecords, name: string): CarrierSet[] {
  const quoted = `'${name}'`;
  const rels = source.ids('IFCRELDEFINESBYPROPERTIES');
  const candidates = rels.filter((rel) => {
    const pset = refId(source.slots(rel)?.[5]);
    return source.type(pset) === 'IFCPROPERTYSET' && source.slots(pset)?.[2]?.trim() === quoted;
  });
  if (!candidates.length) return [];
  const uses = new Map<number, number>();
  const count = (id: number | null) => { if (id !== null) uses.set(id, (uses.get(id) ?? 0) + 1); };
  for (const rel of rels) count(refId(source.slots(rel)?.[5]));
  for (const [type, slot] of [['IFCPROPERTYSET', 4], ['IFCCOMPLEXPROPERTY', 3]] as const) {
    for (const id of source.ids(type)) for (const p of listItems(source.slots(id)?.[slot] ?? '') ?? []) count(refId(p));
  }
  return candidates.map((rel) => {
    const args = source.slots(rel)!;
    const pset = refId(args[5])!;
    const propIds = (listItems(source.slots(pset)![4]) ?? []).map(refId);
    const props = new Map<string, number>();
    for (const p of propIds) {
      const propName = stepString(source.slots(p)?.[0]);
      if (p !== null && propName !== null) props.set(propName, p);
    }
    const related = (listItems(args[4]) ?? []).map(refId).filter((r): r is number => r !== null);
    const exclusive = uses.get(pset) === 1 && propIds.every((p) => p !== null && uses.get(p) === 1);
    return { rel, pset, related, props, exclusive };
  });
}

/**
 * The records of a property set named `name` holding `properties` (STEP bodies
 * such as `IFCPROPERTYSINGLEVALUE(...)`) and relating it to `object`, with
 * GlobalIds derived from `seed`. `ids` numbers them in the target file.
 */
export function writeCarrierSet(ids: () => number, seed: string, ownerHistory: string, name: string, object: number, properties: readonly string[]): string[] {
  const lines: string[] = [];
  const propIds = properties.map((body) => {
    const id = ids();
    lines.push(`#${id}=${body};`);
    return `#${id}`;
  });
  const pset = ids();
  lines.push(`#${pset}=IFCPROPERTYSET('${deterministicGlobalId(`${seed}:pset`)}',${ownerHistory},'${name}',$,(${propIds.join(',')}));`);
  lines.push(`#${ids()}=IFCRELDEFINESBYPROPERTIES('${deterministicGlobalId(`${seed}:rel`)}',${ownerHistory},$,$,(#${object}),#${pset});`);
  return lines;
}
