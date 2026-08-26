/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read one entity's parsed STEP arguments and resolve a named attribute to
 * its positional slot — the two primitives `anonymize-placement.ts` and
 * `anonymize-scrub.ts` (#2934) need to walk a placement chain and locate a
 * `Name`/`LongName`/`GlobalId` slot by EXPRESS name rather than a hardcoded
 * index that would silently drift from the schema.
 *
 * Deliberately thin: this module owns none of the parsing rules itself. It
 * composes `decodeRange` (`source-ref-bounds.ts`, the same readability gate
 * every other byte-range read in this package uses — #2491) with
 * `splitTopLevelArgs` (`step-argument-parser.ts`, the same quote/paren-aware
 * splitter `filterHiddenRefsFromRelationshipLine` uses) so a second,
 * independent STEP-line parser cannot disagree with the ones the rest of the
 * exporter already relies on.
 */

import type { IfcSourceBytes } from '@ifc-lite/parser';
import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';
import { createSourceRefReader, decodeRange } from './source-ref-bounds.js';
import { splitTopLevelArgs } from './step-argument-parser.js';

/** One entity's parsed STEP record: its type token and top-level arguments,
 *  in declaration order (still raw STEP tokens — `#N`, `'text'`, `$`, `.T.`,
 *  a nested `(...)` list — not decoded values). */
export interface SubsetEntityArgs {
  /** UPPERCASE STEP type token, e.g. `IFCLOCALPLACEMENT`. */
  readonly type: string;
  readonly args: readonly string[];
}

/** The slice of an entity index this module reads: a byte-range lookup, same
 *  shape `collectReferencedEntityIds` and `collectStyleEntities` already take. */
export interface EntityByteRangeIndex {
  get(id: number): { byteOffset: number; byteLength: number; type?: string } | undefined;
}

/**
 * Read entity `id`'s STEP record out of `store`'s source and split it into
 * its type token and top-level argument list. Returns `null` when the id has
 * no entry in `index`, or when `index`'s byte range cannot actually be read
 * out of `store.source` (`createSourceRefReader` — the same gate
 * `step-pass-builder.ts`'s `isReadableSourceRef` applies), or when the bytes
 * at that range do not parse as a single `#N=TYPE(...);` record.
 *
 * Only reads SOURCE-backed records. An overlay-created entity (no bytes to
 * decode) is out of scope for this module: `anonymize-placement.ts` and
 * `anonymize-scrub.ts` only ever walk/mutate the entities a freshly-parsed
 * source model contains, never ones the private `MutablePropertyView` they
 * build has itself just created.
 */
export function readEntityArgs(
  store: { readonly source: IfcSourceBytes },
  index: EntityByteRangeIndex,
  id: number,
): SubsetEntityArgs | null {
  const ref = index.get(id);
  if (!ref) return null;
  const isReadable = createSourceRefReader(store.source);
  if (!isReadable(ref)) return null;

  const line = decodeRange(store.source, ref.byteOffset, ref.byteOffset + ref.byteLength);
  const match = line.match(/^#\d+\s*=\s*(\w+)\(([\s\S]*)\)\s*;\s*$/);
  if (!match) return null;
  const [, type, argsText] = match;
  return { type: type.toUpperCase(), args: splitTopLevelArgs(argsText) };
}

/**
 * Zero-based positional index of attribute `name` on `type`, or `-1` when
 * `type` declares no such attribute (an unknown type, or a genuine typo).
 * Backed by `getAttributeNamesAcrossSchemas`, which already resolves across
 * the bundled schema union rather than one pinned registry (#2003) — the
 * same resolver `attribute-real-slots.ts`'s `getRealTypedSlots` uses for the
 * equivalent by-name-to-by-index lookup.
 */
export function attrIndex(type: string, name: string): number {
  return getAttributeNamesAcrossSchemas(type).indexOf(name);
}
