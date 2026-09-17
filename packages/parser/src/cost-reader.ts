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
import { costOverlaySlotOverrides, type CostMutationOverlay } from './cost-overlay.js';
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
 * first: a tombstoned entity does not exist (no id, no type, no record), and a
 * pending attribute edit is spliced into the slot it will occupy in the
 * exported file. This is the one place the overlay is applied — see
 * `cost-overlay.ts` for why it is here and not on the finished graph. The
 * caches below are per-reader and a reader is built per extraction, so an
 * overlaid read never reuses an unoverlaid entry.
 */
export class CostEntityReader {
  private readonly extractor: EntityExtractor;
  private readonly source: IfcSourceBytes;
  private readonly cache = new Map<number, IfcEntity | null>();
  private readonly lexemeCache = new Map<number, string[]>();
  private readonly overlay: CostMutationOverlay | undefined;

  constructor(private readonly store: IfcDataStore, overlay?: CostMutationOverlay) {
    this.source = new CostSourceCache(asSourceBytes(store.source));
    this.extractor = new EntityExtractor(this.source);
    this.overlay = overlay;
  }

  /** True when a pending edit has deleted `expressId` from the loaded model. */
  private isDeleted(expressId: number): boolean {
    return this.overlay?.isDeleted?.(expressId) === true;
  }

  /** Pending slot overrides for `expressId`, resolved against its own type. */
  private slotOverrides(expressId: number): Map<number, { raw: string; lexeme: string }> | undefined {
    if (!this.overlay) return undefined;
    const type = getEntityRefFromStore(this.store, expressId)?.type;
    if (type === undefined) return undefined;
    return costOverlaySlotOverrides(this.overlay, expressId, type, this.store.schemaVersion);
  }

  ids(type: string): readonly number[] {
    const ids = this.store.entityIndex.byType.get(type.toUpperCase()) ?? [];
    if (!this.overlay?.isDeleted) return ids;
    return ids.filter(id => !this.isDeleted(id));
  }

  get schemaVersion(): IfcDataStore['schemaVersion'] {
    return this.store.schemaVersion;
  }

  get(expressId: number): IfcEntity | null {
    const cached = this.cache.get(expressId);
    if (cached !== undefined) return cached;
    const ref = this.isDeleted(expressId) ? null : getEntityRefFromStore(this.store, expressId);
    let entity = ref ? this.extractor.extractEntity(ref) : null;
    const overrides = entity ? this.slotOverrides(expressId) : undefined;
    if (entity && overrides) {
      const attributes = [...(entity.attributes ?? [])];
      for (const [index, override] of overrides) attributes[index] = override.raw;
      entity = { ...entity, attributes };
    }
    this.cache.set(expressId, entity);
    return entity;
  }

  typeOf(expressId: number): string | undefined {
    if (this.isDeleted(expressId)) return undefined;
    return getEntityRefFromStore(this.store, expressId)?.type.toUpperCase();
  }

  attributeLexeme(expressId: number, index: number): string | undefined {
    let lexemes = this.lexemeCache.get(expressId);
    if (!lexemes) {
      const ref = this.isDeleted(expressId) ? null : getEntityRefFromStore(this.store, expressId);
      lexemes = ref
        ? splitCostAttributeLexemes(this.source.decodeUtf8(ref.byteOffset, ref.byteOffset + ref.byteLength))
        : [];
      const overrides = ref ? this.slotOverrides(expressId) : undefined;
      if (overrides) for (const [slot, override] of overrides) lexemes[slot] = override.lexeme;
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
