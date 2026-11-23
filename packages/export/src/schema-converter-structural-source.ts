/* SPDX-License-Identifier: MPL-2.0 */
/**
 * What the structural conversion prepasses (#9668) share: the schema pair they
 * run for, memoized reads of source records, subtype tests, and the property-set
 * carrier some of them write into the target file and read back from the source.
 */
import { stepStringLiteralEnd } from '@ifc-lite/encoding';
import { deterministicGlobalId, getCanonicalEntityName, getSchemaRegistryForVersion, type IfcDataStore } from '@ifc-lite/parser';
import { listItems } from './schema-converter-structural-axes.js';
import { decodeRange } from './source-ref-bounds.js';
import { readStepSlots } from './step-argument-parser.js';
import { stepRecordHead } from './step-record-frame.js';
import { parseStepNumber, skipStepTrivia } from './step-slot-grammar.js';
import { namedExpressIds, referencesAnyExpressId } from './step-ref-scan.js';

export type ConversionMode = 'upgrade' | 'downgrade' | null;

/** What the prepasses read: the source index and bytes. */
export type SourceStore = Pick<IfcDataStore, 'entityIndex' | 'deferredEntityIndex' | 'source'>;

/** IFC2X3 -> IFC4 is an upgrade, IFC4 -> IFC2X3 a downgrade; the prepasses run for nothing else. */
export const conversionMode = (from: string, to: string): ConversionMode =>
  from === 'IFC2X3' && to === 'IFC4' ? 'upgrade' : from === 'IFC4' && to === 'IFC2X3' ? 'downgrade' : null;

/** Whether any of `args` names an id this export withholds. */
export const namesWithheld = (args: readonly string[] | undefined, withheld: ReadonlySet<number> | undefined): boolean =>
  !!withheld?.size && !!args?.some((a) => referencesAnyExpressId(a, withheld));

/**
 * A target record body, `null` for a source record the target leaves out, and
 * what the change loses or moves. `restored` names, per source record id, the
 * attributes the target holds elsewhere and the reverse conversion writes back;
 * the loss report leaves them out (`structuralRoundTrip`).
 */
export interface StructuralRewrite {
  readonly body: string | null;
  readonly losses: readonly string[];
  readonly restored?: readonly (readonly [number, readonly string[]])[];
}

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
  private readonly keptIdsByType = new Map<string, readonly number[]>();
  private readonly cache = new Map<number, readonly string[] | undefined>();
  constructor(private readonly store: SourceStore) {}

  hasIndexedRecords(): boolean {
    // @raw-entity-enumeration-ok distinguish a parsed source index from type-only preview input
    return this.store.entityIndex.byId.size > 0 || (this.store.deferredEntityIndex?.size ?? 0) > 0;
  }

  private decode(entry: { byteOffset: number; byteLength: number }): string {
    return decodeRange(this.store.source, entry.byteOffset, entry.byteOffset + entry.byteLength);
  }

  /**
   * How many source records name each of `targets`, outside strings and
   * comments. Reads every record, so callers ask only when they have targets.
   */
  referrers(targets: ReadonlySet<number>): Map<number, number> {
    const uses = new Map<number, number>();
    for (const { named } of this.naming(targets)) for (const t of named) uses.set(t, (uses.get(t) ?? 0) + 1);
    return uses;
  }

  /**
   * Each source record naming any of `targets` outside strings and comments,
   * and which ones. Reads every record and caches nothing, so callers ask only
   * when they have targets.
   */
  *naming(targets: ReadonlySet<number>): Generator<{ id: number; named: ReadonlySet<number> }> {
    if (targets.size === 0) return;
    for (const { id, text } of this.texts()) {
      const head = stepRecordHead(text);
      const named = namedExpressIds(text.slice(head?.open ?? skipStepTrivia(text, 0) + 1), targets);
      if (named.size) yield { id, named };
    }
  }

  /** The kept source records, including deferred atoms, without caching their text. */
  *texts(): Generator<{ id: number; text: string }> {
    const deferred = this.store.deferredEntityIndex;
    // @raw-entity-enumeration-ok same unedited source-only prepass
    const primary = this.store.entityIndex.byId;
    for (const index of deferred ? [primary, deferred] : [primary]) {
      for (const [id, entry] of index) {
        if (deferred && this.entry(id) !== entry) continue;
        yield { id, text: this.decode(entry) };
      }
    }
  }

  /** A repeated id belongs to its last record, at that record's position. */
  ids(type: string): readonly number[] {
    const cached = this.keptIdsByType.get(type);
    if (cached) return cached;
    // @raw-entity-enumeration-ok conversion prepass is enabled only for an unedited full-source export (step-pass-builder.ts)
    const ids = this.store.entityIndex.byType.get(type) ?? [];
    const last = new Map<number, number>();
    ids.forEach((id, i) => last.set(id, i));
    const kept = ids.filter((id, i) => last.get(id) === i && this.type(id) === type);
    this.keptIdsByType.set(type, kept);
    return kept;
  }

  private entry(id: number) {
    // @raw-entity-enumeration-ok same unedited source-only prepass
    const primary = this.store.entityIndex.byId.get(id);
    const deferred = this.store.deferredEntityIndex?.get(id);
    return deferred && (!primary || deferred.byteOffset > primary.byteOffset) ? deferred : primary;
  }

  type(id: number | null): string | undefined {
    return id === null ? undefined : this.entry(id)?.type.toUpperCase();
  }

  slots(id: number | null): readonly string[] | undefined {
    if (id === null) return undefined;
    if (!this.cache.has(id)) {
      const entry = this.entry(id);
      this.cache.set(id, entry ? readStepSlots(this.decode(entry))?.slots : undefined);
    }
    return this.cache.get(id);
  }
}

/** An entity reference slot, with STEP whitespace and comments around it allowed (#10248). */
export function slotRef(token: string | undefined): number | null {
  const text = token ?? '';
  const start = skipStepTrivia(text, 0);
  const m = start < 0 ? null : /^#\s*(\d+)/.exec(text.slice(start));
  return m && skipStepTrivia(text, start + m[0].length) === text.length ? Number(m[1]) : null;
}

/** Whether the slot is the unset marker `$`, with STEP whitespace and comments around it allowed (#10248). */
export function slotUnset(token: string | undefined): boolean {
  const text = token ?? '';
  const start = skipStepTrivia(text, 0);
  return start >= 0 && text[start] === '$' && skipStepTrivia(text, start + 1) === text.length;
}

/** The bare number of `token`, given as such or wrapped as `TYPE(n)`, or null when it is not a finite number. */
export function bareMeasure(token: string | undefined, type: string): string | null {
  const wrapped = new RegExp(`^\\s*${type}\\s*\\((.*)\\)\\s*$`, 'i').exec(token ?? '')?.[1];
  const bare = (wrapped ?? token ?? '').trim();
  return Number.isFinite(parseStepNumber(bare)) ? bare : null;
}

/** The text of a STEP string token, or null. Only compared with fixed names here, so escapes need no decoding. */
export function stepString(token: string | undefined): string | null {
  // STEP whitespace and comments may sit around the string (#10248), never inside the quotes.
  const text = token ?? '';
  const start = skipStepTrivia(text, 0);
  if (start < 0 || text[start] !== "'") return null;
  const end = stepStringLiteralEnd(text, start);
  return end > start && skipStepTrivia(text, end) === text.length ? text.slice(start + 1, end - 1) : null;
}

/** A property set attached by an IfcRelDefinesByProperties, read from the source. */
export interface CarrierSet {
  readonly rel: number;
  readonly pset: number;
  readonly related: readonly number[];
  /** Property name -> its id; empty for a set that names two properties alike or lists one it cannot read, or whose relationship lists a non-reference; such a set is never read. */
  readonly props: ReadonlyMap<string, number>;
  /** Whether the set and each of its properties are named by no other source record than this relationship and this set; undefined unless `checkExclusive`. */
  readonly exclusive?: boolean;
}

/** Every property set named `name` in the source, with what it relates to; `exclusive`, which reads every record, only with `checkExclusive`. */
export function readCarrierSets(source: SourceRecords, name: string, checkExclusive = true): CarrierSet[] {
  const rels = source.ids('IFCRELDEFINESBYPROPERTIES');
  const candidates = rels.filter((rel) => {
    const pset = slotRef(source.slots(rel)?.[5]);
    return source.type(pset) === 'IFCPROPERTYSET' && stepString(source.slots(pset)?.[2]) === name;
  });
  if (!candidates.length) return [];
  const members = candidates.map((rel) => {
    const pset = slotRef(source.slots(rel)![5])!;
    return { rel, pset, propIds: (listItems(source.slots(pset)?.[4] ?? '') ?? []).map(slotRef) };
  });
  // A carrier is exclusive when its relationship is the only record naming its set, and its set the only one naming each property.
  const uses = checkExclusive ? source.referrers(new Set(members.flatMap(({ pset, propIds }) => [pset, ...propIds.filter((p): p is number => p !== null)]))) : undefined;
  return members.map(({ rel, pset, propIds }) => {
    // IfcPropertySet names its properties uniquely (IFC4 UniquePropertyNames, IFC2X3 WR32). A set that does
    // not, that lists a property it cannot read, or whose relationship lists a non-reference, still counts as
    // present for the objects it does name (for ambiguity checks) but gives no property and is never consumed.
    const listed = listItems(source.slots(rel)?.[4] ?? '')?.map(slotRef) ?? [];
    const related = listed.filter((r): r is number => r !== null);
    const props = new Map<string, number>();
    if (related.length === listed.length) {
      for (const p of propIds) {
        const propName = stepString(source.slots(p)?.[0]);
        if (p === null || propName === null || props.has(propName)) { props.clear(); break; }
        props.set(propName, p);
      }
    }
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
