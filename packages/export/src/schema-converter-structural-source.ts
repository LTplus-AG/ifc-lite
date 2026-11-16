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
import { parseStepNumber, skipStepTrivia } from './step-slot-grammar.js';
import { namedExpressIds, referencesAnyExpressId } from './step-ref-scan.js';

export type ConversionMode = 'upgrade' | 'downgrade' | null;

/** IFC2X3 -> IFC4 is an upgrade, IFC4 -> IFC2X3 a downgrade; the prepasses run for nothing else. */
export const conversionMode = (from: string, to: string): ConversionMode =>
  from === 'IFC2X3' && to === 'IFC4' ? 'upgrade' : from === 'IFC4' && to === 'IFC2X3' ? 'downgrade' : null;

/** Whether any of `args` names an id this export withholds. */
export const namesWithheld = (args: readonly string[] | undefined, withheld: ReadonlySet<number> | undefined): boolean =>
  !!withheld?.size && !!args?.some((a) => referencesAnyExpressId(a, withheld));

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

  /**
   * How many source records name each of `targets`, outside strings and
   * comments. Reads every record, so callers ask only when they have targets.
   */
  referrers(targets: ReadonlySet<number>): Map<number, number> {
    const uses = new Map<number, number>();
    // @raw-entity-enumeration-ok same unedited source-only prepass
    for (const entry of this.store.entityIndex.byId.values()) {
      const text = decodeRange(this.store.source, entry.byteOffset, entry.byteOffset + entry.byteLength);
      const args = text.slice(Math.max(0, text.indexOf('(')));
      if (!referencesAnyExpressId(args, targets)) continue;
      for (const t of namedExpressIds(args, targets)) uses.set(t, (uses.get(t) ?? 0) + 1);
    }
    return uses;
  }

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

/** Whether the slot is the unset marker `$`, with STEP whitespace and comments around it allowed (#10248). */
export function slotUnset(token: string): boolean {
  const start = skipStepTrivia(token, 0);
  return start >= 0 && token[start] === '$' && skipStepTrivia(token, start + 1) === token.length;
}

/** The bare number of `token`, given as such or wrapped as `TYPE(n)`, or null when it is not a finite number. */
export function bareMeasure(token: string | undefined, type: string): string | null {
  const wrapped = new RegExp(`^\\s*${type}\\s*\\((.*)\\)\\s*$`, 'i').exec(token ?? '')?.[1];
  const bare = (wrapped ?? token ?? '').trim();
  return Number.isFinite(parseStepNumber(bare)) ? bare : null;
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
  /** Whether the set and each of its properties are named by no other source record than this relationship and this set; undefined unless `checkExclusive`. */
  readonly exclusive?: boolean;
}

/** Every property set named `name` in the source, with what it relates to; `exclusive`, which reads every record, only with `checkExclusive`. */
export function readCarrierSets(source: SourceRecords, name: string, checkExclusive = true): CarrierSet[] {
  const quoted = `'${name}'`;
  const rels = source.ids('IFCRELDEFINESBYPROPERTIES');
  const candidates = rels.filter((rel) => {
    const pset = refId(source.slots(rel)?.[5]);
    return source.type(pset) === 'IFCPROPERTYSET' && source.slots(pset)?.[2]?.trim() === quoted;
  });
  if (!candidates.length) return [];
  const members = candidates.map((rel) => {
    const pset = refId(source.slots(rel)![5])!;
    return { rel, pset, propIds: (listItems(source.slots(pset)![4]) ?? []).map(refId) };
  });
  // A carrier is exclusive when its relationship is the only record naming its set, and its set the only one naming each property.
  const uses = checkExclusive ? source.referrers(new Set(members.flatMap(({ pset, propIds }) => [pset, ...propIds.filter((p): p is number => p !== null)]))) : undefined;
  return members.map(({ rel, pset, propIds }) => {
    const props = new Map<string, number>();
    for (const p of propIds) {
      const propName = stepString(source.slots(p)?.[0]);
      if (p !== null && propName !== null) props.set(propName, p);
    }
    const related = (listItems(source.slots(rel)![4]) ?? []).map(refId).filter((r): r is number => r !== null);
    const exclusive = uses ? uses.get(pset) === 1 && propIds.every((p) => p !== null && uses.get(p) === 1) : undefined;
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
