/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The live-session overlay as the IDS bridge sees it (#5184, #5249).
 *
 * Enumeration (`getAllEntityIds`, `getEntitiesByType`) goes through the shared
 * `iterateEffectiveEntities` in `@ifc-lite/data`, so a tombstoned entity is not
 * validated and an overlay-created one is. An enumerated entity is only
 * validated if the point reads agree with the enumeration. The validator
 * confirms every candidate through `getEntityType`, so an overlay-created
 * entity with no type answer would be listed and then silently dropped. This
 * module answers those reads for overlay-created and retyped entities:
 *
 *   - `typeOf`: the effective class (retype applied) of a created or retyped
 *     entity, `undefined` for anything else, so the store answers as before;
 *   - `createdAttributes`: a created entity's authored attributes, named from
 *     the schema. It has no source bytes for `extractAllEntityAttributes`.
 *
 * Attribute EDITS (`setAttribute`) on source or created entities are still not
 * reflected. The bridge has never consulted them for source entities either,
 * and that gap is separate from enumeration.
 */

import type { EffectiveEntityOverlay } from '@ifc-lite/data';
import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';

/**
 * Overlay entity visibility, decoupled from `@ifc-lite/mutations` in the same
 * way `PropertyOverlayResolver` is: this package does not depend on it. A live
 * `MutablePropertyView` satisfies this shape as-is. A caller that only has a
 * structured-clone snapshot (the IDS worker) hands in a plain object instead.
 */
export interface EntityVisibilityView extends EffectiveEntityOverlay {
  /**
   * Overlay-created entities still alive, with their authored class and
   * positional attributes (`MutablePropertyView.getNewEntities()`).
   */
  getNewEntities(): ReadonlyArray<{
    readonly expressId: number;
    readonly type: string;
    readonly attributes?: ReadonlyArray<unknown>;
  }>;
}

type AttributeValue = string | number | boolean;

export interface OverlayEntityLookup {
  typeOf(expressId: number): string | undefined;
  createdAttributes(expressId: number): Array<{ name: string; value: AttributeValue }> | undefined;
}

/**
 * Attributes the parser's `extractAllEntityAttributes` omits
 * (`SKIP_DISPLAY_ATTRS`). A created entity reports the same attribute names a
 * parsed one does. Its GlobalId is still answered through `globalIdOf`.
 */
const SKIPPED_ATTRIBUTES = new Set([
  'GlobalId', 'OwnerHistory', 'ObjectPlacement', 'Representation', 'HasPropertySets', 'RepresentationMaps',
]);

/**
 * Index the overlay's created and retyped entities once per accessor. The
 * validator's `getEntityType` is hot (once per candidate), and
 * `getNewEntities()` copies on every call.
 */
export function overlayEntityLookup(view: EntityVisibilityView): OverlayEntityLookup & {
  globalIdOf(expressId: number): string | undefined;
} {
  const created = new Map<number, { type: string; attributes: ReadonlyArray<unknown> }>();
  for (const entity of view.getNewEntities()) {
    created.set(entity.expressId, { type: entity.type, attributes: entity.attributes ?? [] });
  }
  const retypes = view.getTypeMutations?.() ?? new Map<number, { readonly newType: string }>();
  const attributeCache = new Map<number, Array<{ name: string; value: AttributeValue }>>();

  function namedAttributes(expressId: number): Array<{ name: string; value: AttributeValue }> | undefined {
    const entity = created.get(expressId);
    if (!entity) return undefined;
    let named = attributeCache.get(expressId);
    if (!named) {
      named = [];
      const names = getAttributeNamesAcrossSchemas(entity.type);
      const len = Math.min(names.length, entity.attributes.length);
      for (let i = 0; i < len; i++) {
        const value = scalarAttributeValue(entity.attributes[i]);
        if (value !== undefined) named.push({ name: names[i], value });
      }
      attributeCache.set(expressId, named);
    }
    return named;
  }

  return {
    typeOf(expressId) {
      const retype = retypes.get(expressId);
      if (retype) return retype.newType;
      return created.get(expressId)?.type;
    },
    createdAttributes(expressId) {
      return namedAttributes(expressId)?.filter((a) => !SKIPPED_ATTRIBUTES.has(a.name));
    },
    globalIdOf(expressId) {
      const value = namedAttributes(expressId)?.find((a) => a.name === 'GlobalId')?.value;
      return typeof value === 'string' && value ? value : undefined;
    },
  };
}

/**
 * The scalar an authored attribute holds, normalised the way
 * `extractAllEntityAttributes` normalises a parsed one: `.ENUM.` markers
 * stripped, `.T.`/`.F.` as booleans, logical-unknown and unset as absent,
 * typed wrappers unwrapped. References and aggregates are not attribute
 * values the IDS attribute facet compares, so they are absent.
 */
function scalarAttributeValue(raw: unknown): AttributeValue | undefined {
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    if (raw === '.U.' || raw === '.X.') return undefined;
    if (raw === '.T.') return true;
    if (raw === '.F.') return false;
    if (/^#\d+$/.test(raw)) return undefined;
    return raw.length > 1 && raw.startsWith('.') && raw.endsWith('.') ? raw.slice(1, -1) : raw;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if ('real' in raw && typeof raw.real === 'number') return raw.real;
    // A typed value is data, not a STEP token (#5249): the writer
    // (`serializeTypedMarker`) emits it as-is inside its type wrapper, so a
    // typed label reading `#22` or `.T.` is that text, never a ref or boolean.
    if ('typed' in raw && raw.typed && typeof raw.typed === 'object' && 'value' in raw.typed) {
      const value: unknown = raw.typed.value;
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
    }
  }
  return undefined;
}
