/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcEntity } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { getEntityRefFromStore } from './columnar-parser-root-attributes.js';
import { EntityExtractor } from './entity-extractor.js';
import {
  costAttributePresent, costNumericLexeme, costNumericTypeLexeme, costReferenceLexeme, costReferenceListLexeme,
  splitCostAttributeLexemes,
} from './cost-step-lexemes.js';
import type { CostMutationOverlay } from './cost-overlay.js';
import type { CostDiagnostic } from './cost-types.js';
import { asSourceBytes, type IfcSourceBytes } from './source-bytes.js';

class CostSourceCache implements IfcSourceBytes {
  private readonly decoded = new Map<string, string>();
  constructor(private readonly source: IfcSourceBytes) {}
  get byteLength(): number { return this.source.byteLength; }
  get length(): number { return this.source.length; }
  get isResident(): boolean { return this.source.isResident; }
  get contentKey(): string | null { return this.source.contentKey; }
  slice(start: number, end: number): Uint8Array { return this.source.slice(start, end); }
  decodeUtf8(start: number, end: number): string {
    const key = `${start}:${end}`;
    const cached = this.decoded.get(key);
    if (cached !== undefined) return cached;
    const decoded = this.source.decodeUtf8(start, end);
    this.decoded.set(key, decoded);
    return decoded;
  }
  materialize(): Uint8Array { return this.source.materialize(); }
  withMaterialized<T>(fn: (bytes: Uint8Array) => T): T { return this.source.withMaterialized(fn); }
  withMaterializedAsync<T>(fn: (bytes: Uint8Array) => Promise<T>): Promise<T> {
    return this.source.withMaterializedAsync(fn);
  }
  toTransferable(): ReturnType<IfcSourceBytes['toTransferable']> { return this.source.toTransferable(); }
}

/**
 * Memoized source reader used once per cost extraction.
 *
 * When an {@link CostMutationOverlay} is supplied, every read goes through it
 * first: a tombstoned entity does not exist (no id, no type, no record), a
 * retyped entity is listed under and reports its pending class, and a record
 * any pending edit reaches is read from the text the exporter will write for
 * it. This is the one place the overlay is applied — see `cost-overlay.ts`
 * for why it is here and not on the finished graph. The caches below are
 * per-reader and a reader is built per extraction, so an overlaid read never
 * reuses an unoverlaid entry.
 */
export class CostEntityReader {
  private readonly extractor: EntityExtractor;
  private readonly source: IfcSourceBytes;
  private readonly cache = new Map<number, IfcEntity | null>();
  private readonly lexemeCache = new Map<number, string[]>();
  private readonly recordCache = new Map<number, string | null | undefined>();
  private retyped: ReadonlyMap<number, string> | undefined;

  constructor(
    private readonly store: IfcDataStore,
    private readonly overlay?: CostMutationOverlay,
    private readonly diagnostics?: CostDiagnostic[],
  ) {
    this.source = new CostSourceCache(asSourceBytes(store.source));
    this.extractor = new EntityExtractor(this.source);
  }

  /** True when a pending edit has deleted `expressId` from the loaded model. */
  private isDeleted(expressId: number): boolean {
    return this.overlay?.isDeleted(expressId) === true;
  }

  /** Pending retypes, UPPERCASE, restricted to entities the source actually has. */
  private retypes(): ReadonlyMap<number, string> {
    if (!this.retyped) {
      const retyped = new Map<number, string>();
      for (const [id, type] of this.overlay?.retypes() ?? []) {
        if (getEntityRefFromStore(this.store, id)) retyped.set(id, type.toUpperCase());
      }
      this.retyped = retyped;
    }
    return this.retyped;
  }

  /**
   * The record text an overlaid read sees, or `undefined` when the record
   * reads exactly as the source states it (no overlay, or no edit reaches it)
   * and the unoverlaid source path applies. `null` means no record at all.
   */
  private overlaidRecord(expressId: number): string | null | undefined {
    if (!this.overlay) return undefined;
    if (this.recordCache.has(expressId)) return this.recordCache.get(expressId);
    const ref = this.isDeleted(expressId) ? null : getEntityRefFromStore(this.store, expressId);
    let text: string | null | undefined = null;
    if (ref) {
      const sourceText = this.source.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength);
      const effective = this.overlay.effectiveRecord(expressId, sourceText, ref.type);
      // Unchanged text reads through the shared source extractor and caches.
      text = effective.text === sourceText ? undefined : effective.text;
      for (const reason of effective.notWritten) {
        this.diagnostics?.push({
          Code: 'PENDING_EDIT_NOT_APPLIED', Severity: 'warning', expressId,
          Message: `A pending edit to #${expressId} is not written on export and is not reflected here: ${reason}`,
        });
      }
    }
    this.recordCache.set(expressId, text);
    return text;
  }

  ids(type: string): readonly number[] {
    const wanted = type.toUpperCase();
    const ids = this.store.entityIndex.byType.get(wanted) ?? [];
    if (!this.overlay) return ids;
    const retyped = this.retypes();
    const kept = ids.filter(id => !this.isDeleted(id) && (retyped.get(id) ?? wanted) === wanted);
    const retypedIn = [...retyped].filter(([id, newType]) => newType === wanted && !this.isDeleted(id) && !ids.includes(id));
    if (retypedIn.length === 0) return kept;
    return [...kept, ...retypedIn.map(([id]) => id)].sort((a, b) => a - b);
  }

  get schemaVersion(): IfcDataStore['schemaVersion'] {
    return this.store.schemaVersion;
  }

  get(expressId: number): IfcEntity | null {
    const cached = this.cache.get(expressId);
    if (cached !== undefined) return cached;
    const record = this.overlaidRecord(expressId);
    let entity: IfcEntity | null;
    if (record === undefined) {
      const ref = getEntityRefFromStore(this.store, expressId);
      entity = ref ? this.extractor.extractEntity(ref) : null;
    } else if (record === null) {
      entity = null;
    } else {
      const bytes = new TextEncoder().encode(record);
      entity = new EntityExtractor(bytes).extractEntity({
        expressId, type: this.typeOf(expressId) ?? '', byteOffset: 0, byteLength: bytes.byteLength, lineNumber: 0,
      });
    }
    this.cache.set(expressId, entity);
    return entity;
  }

  typeOf(expressId: number): string | undefined {
    if (this.isDeleted(expressId)) return undefined;
    const type = getEntityRefFromStore(this.store, expressId)?.type.toUpperCase();
    if (type === undefined || !this.overlay) return type;
    return this.retypes().get(expressId) ?? type;
  }

  attributeLexeme(expressId: number, index: number): string | undefined {
    let lexemes = this.lexemeCache.get(expressId);
    if (!lexemes) {
      const record = this.overlaidRecord(expressId);
      const ref = record === undefined ? getEntityRefFromStore(this.store, expressId) : undefined;
      const text = record ?? (ref ? this.source.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength) : undefined);
      lexemes = text === undefined ? [] : splitCostAttributeLexemes(text);
      this.lexemeCache.set(expressId, lexemes);
    }
    return lexemes[index];
  }

  decimalLexeme(expressId: number, index: number): string | undefined {
    return costNumericLexeme(this.attributeLexeme(expressId, index));
  }

  decimalTypeLexeme(expressId: number, index: number): string | undefined {
    return costNumericTypeLexeme(this.attributeLexeme(expressId, index));
  }

  referenceLexeme(expressId: number, index: number): number | undefined {
    return costReferenceLexeme(this.attributeLexeme(expressId, index));
  }

  referenceListLexeme(expressId: number, index: number): number[] | undefined {
    return costReferenceListLexeme(this.attributeLexeme(expressId, index));
  }

  attributePresent(expressId: number, index: number): boolean {
    return costAttributePresent(this.attributeLexeme(expressId, index));
  }
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asEnum(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\.([A-Z0-9_]+)\.$/i.exec(value);
  return match?.[1]?.toUpperCase();
}

export function asRef(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export function asRefList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: number[] = [];
  for (const entry of value) {
    const ref = asRef(entry);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}
