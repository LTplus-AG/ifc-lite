/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A population of entity instances the compiled rules evaluate against, with
 * the reverse-reference index INVERSE attributes and USEDIN need.
 */

import { EntityInstance } from './instance.js';
import type { InverseMeta } from './schema-meta.js';
import type { ResolvedEntity, SchemaRuntime } from './schema-runtime.js';
import { readStepRecord, splitStepRecords, StepRecordError } from './step-reader.js';
import { Ref, Typed, type Value } from './values.js';

export interface RecordProvider {
  syntaxErrors?: string[];
  duplicateIds?: number[];
  ids(): Iterable<number>;
  /** Upper-case STEP type name of a record. */
  type(id: number): string | undefined;
  text(id: number): string | undefined;
}

export interface StepRecordRef {
  byteOffset: number;
  byteLength: number;
  type?: string;
}

/** The part of `@ifc-lite/parser`'s `IfcDataStore` this package reads. */
export interface StepRecordSource {
  source: { decodeUtf8(start: number, end: number): string };
  entityIndex: { byId: { get(id: number): StepRecordRef | undefined; keys(): Iterable<number>; entries?(): Iterable<[number, StepRecordRef]> } };
}

export function dataStoreRecords(store: StepRecordSource): RecordProvider {
  const byId = store.entityIndex.byId;
  const ids = new Set<number>();
  const duplicateIds: number[] = [];
  for (const id of byId.keys()) {
    if (ids.has(id)) duplicateIds.push(id);
    ids.add(id);
  }
  const first = new Map<number, StepRecordRef>();
  if (duplicateIds.length && byId.entries) {
    const repeated = new Set(duplicateIds);
    for (const [id, ref] of byId.entries()) {
      if (!repeated.has(id)) continue;
      const prior = first.get(id);
      if (!prior || ref.byteOffset < prior.byteOffset) first.set(id, ref);
    }
  }
  const record = (id: number) => first.get(id) ?? byId.get(id);
  return {
    duplicateIds,
    ids: () => ids.keys(),
    type: (id) => record(id)?.type?.toUpperCase(),
    text: (id) => {
      const ref = record(id);
      return ref ? store.source.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength) : undefined;
    },
  };
}

export function stepTextRecords(text: string): RecordProvider {
  const records = new Map<number, { type: string; text: string }>();
  const duplicateIds: number[] = [];
  const syntaxErrors: string[] = [];
  for (const r of splitStepRecords(text, message => syntaxErrors.push(message))) {
    if (records.has(r.id)) duplicateIds.push(r.id);
    else records.set(r.id, { type: r.type, text: r.text });
  }
  return { duplicateIds, syntaxErrors, ids: () => records.keys(), type: (id) => records.get(id)?.type, text: (id) => records.get(id)?.text };
}

function collectRefs(v: Value, out: number[], referrer: number, index: number): void {
  if (v instanceof Ref) out.push(v.id, referrer, index);
  else if (Array.isArray(v)) for (const x of v) collectRefs(x, out, referrer, index);
  else if (v instanceof Typed) collectRefs(v.value, out, referrer, index);
}

export class Model {
  private readonly instances = new Map<number, EntityInstance | null>();
  private readonly entities = new Map<number, ResolvedEntity | null>();
  private readonly populations = new Map<string, EntityInstance[]>();
  private readonly allIds: number[];
  private reverse?: Map<number, number[]>;
  readonly decodeErrors = new Map<number, string>();

  constructor(readonly schema: SchemaRuntime, private readonly records: RecordProvider) {
    this.allIds = [...records.ids()].sort((a, b) => a - b);
  }

  get syntaxErrors(): readonly string[] { return this.records.syntaxErrors ?? []; }

  get duplicateIds(): readonly number[] { return this.records.duplicateIds ?? []; }

  static fromDataStore(store: StepRecordSource, schema: SchemaRuntime): Model {
    return new Model(schema, dataStoreRecords(store));
  }

  static fromStepText(text: string, schema: SchemaRuntime): Model {
    return new Model(schema, stepTextRecords(text));
  }

  ids(): readonly number[] {
    return this.allIds;
  }

  typeName(id: number): string | undefined {
    return this.records.type(id);
  }

  entityOf(id: number): ResolvedEntity | undefined {
    let e = this.entities.get(id);
    if (e === undefined) {
      const t = this.records.type(id);
      e = (t ? this.schema.entities.get(t) : undefined) ?? null;
      this.entities.set(id, e);
    }
    return e ?? undefined;
  }

  get(id: number): EntityInstance | undefined {
    let inst = this.instances.get(id);
    if (inst === undefined) {
      const entity = this.entityOf(id);
      inst = entity ? new EntityInstance(this, id, entity) : null;
      this.instances.set(id, inst);
    }
    return inst ?? undefined;
  }

  decode(id: number): Value[] {
    const text = this.records.text(id);
    if (text === undefined) return [];
    try {
      return readStepRecord(text, (upper) => this.schema.canonicalName(upper) ?? upper).attributes;
    } catch (e) {
      this.decodeErrors.set(id, e instanceof StepRecordError ? e.message : String(e));
      return [];
    }
  }

  /** Every instance of `entity` or one of its subtypes, in id order. */
  population(entity: string): EntityInstance[] {
    const key = entity.toUpperCase();
    let pop = this.populations.get(key);
    if (!pop) {
      const target = this.schema.entities.get(key);
      pop = [];
      if (target) {
        for (const id of this.allIds) {
          const e = this.entityOf(id);
          if (e && e.isA(target.upper)) pop.push(this.get(id)!);
        }
      }
      this.populations.set(key, pop);
    }
    return pop;
  }

  /** Flat `[referrer, attributeIndex, ...]` pairs of the records referencing `id`. */
  referrers(id: number): readonly number[] {
    if (!this.reverse) this.reverse = this.buildReverseIndex();
    return this.reverse.get(id) ?? [];
  }

  inverse(target: EntityInstance, inv: InverseMeta): EntityInstance[] {
    const entity = inv.entity.toUpperCase();
    const forUpper = inv.forAttribute.toUpperCase();
    return this.collectReferrers(target, inv.aggregate === 'BAG', (e, index) => {
      if (!e.isA(entity)) return false;
      const slot = e.slots.get(forUpper);
      return slot?.k === 'explicit' ? slot.index === index : e.attributes.findIndex((a) => a.name.toUpperCase() === forUpper) === index;
    });
  }

  /** EXPRESS USEDIN: referrers through the role `SCHEMA.ENTITY.ATTRIBUTE`, or all referrers for `''`. */
  usedIn(target: EntityInstance, role: string): EntityInstance[] {
    if (!role) return this.collectReferrers(target, true, () => true);
    const parts = role.toUpperCase().split('.');
    const attr = parts.pop()!;
    const entity = parts.pop()!;
    return this.collectReferrers(target, true, (e, index) => {
      if (!e.isA(entity)) return false;
      const slot = e.slots.get(attr);
      return slot?.k === 'explicit' && slot.index === index;
    });
  }

  private collectReferrers(target: EntityInstance, keepDuplicates: boolean, match: (e: ResolvedEntity, index: number) => boolean): EntityInstance[] {
    if (target.transient) return [];
    const pairs = this.referrers(target.id);
    const out: EntityInstance[] = [];
    const seen = new Set<number>();
    for (let k = 0; k < pairs.length; k += 2) {
      const r = pairs[k];
      if (!keepDuplicates && seen.has(r)) continue;
      const inst = this.get(r);
      if (!inst || !match(inst.entity, pairs[k + 1])) continue;
      seen.add(r);
      out.push(inst);
    }
    return out;
  }

  private buildReverseIndex(): Map<number, number[]> {
    const triples: number[] = [];
    for (const id of this.allIds) {
      const inst = this.get(id);
      if (!inst) continue;
      const attrs = inst.attributes;
      for (let i = 0; i < attrs.length; i++) collectRefs(attrs[i], triples, id, i);
    }
    const index = new Map<number, number[]>();
    for (let k = 0; k < triples.length; k += 3) {
      let list = index.get(triples[k]);
      if (!list) index.set(triples[k], (list = []));
      list.push(triples[k + 1], triples[k + 2]);
    }
    return index;
  }
}
