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
import { getAttributeNamesAcrossSchemas, SCHEMA_REGISTRY } from '@ifc-lite/parser';

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
    if ('typed' in raw && raw.typed && typeof raw.typed === 'object' && 'value' in raw.typed) {
      return typedAuthoredValue(raw.typed as { type?: unknown; value: unknown });
    }
  }
  return undefined;
}

/** EXPRESS base primitives a defined type ultimately resolves to. */
const EXPRESS_PRIMITIVES = new Set(['BOOLEAN', 'LOGICAL', 'INTEGER', 'REAL', 'NUMBER', 'STRING', 'BINARY']);

/**
 * The EXPRESS primitive an IFC defined type resolves to, by walking the schema
 * registry's `types` alias chain: the same lookup the STEP writer uses
 * (`resolveExpressBase` in `@ifc-lite/export`, which this package cannot
 * depend on). `null` for an unknown type.
 */
function expressBase(typeName: string): string | null {
  let cursor: string | undefined = typeName;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const underlying: string | undefined = Object.prototype.hasOwnProperty.call(SCHEMA_REGISTRY.types, cursor)
      ? SCHEMA_REGISTRY.types[cursor]
      : undefined;
    if (!underlying) return null;
    const head = underlying.replace(/\(.*$/, '').trim().toUpperCase();
    if (EXPRESS_PRIMITIVES.has(head)) return head;
    cursor = underlying;
  }
  return null;
}

/** The writer's tri-state reading of a boolean/logical inner value. */
function coerceLogical(value: string | number | boolean): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const t = value.trim().toUpperCase();
  if (t === 'TRUE' || t === '.T.' || t === 'T' || t === '1') return true;
  if (t === 'FALSE' || t === '.F.' || t === 'F' || t === '0') return false;
  return null;
}

/**
 * The value of an authored `{ typed: { type, value } }` marker as the STEP
 * writer emits it (#5249), converted by the type's EXPRESS base exactly as
 * `serializeInnerByBase` does: REAL/NUMBER as a number, INTEGER truncated,
 * BOOLEAN as a boolean (unrecognised reads `false`), LOGICAL tri-state (unknown
 * is absent), STRING/BINARY as literal text, so a typed label reading `#22` is
 * that text, never a reference. An unknown type infers from the JS value.
 */
export function typedAuthoredValue(typed: { type?: unknown; value: unknown }): AttributeValue | undefined {
  const { value } = typed;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return undefined;
  switch (typeof typed.type === 'string' ? expressBase(typed.type) : null) {
    case 'REAL':
    case 'NUMBER': {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'INTEGER': {
      const n = Math.trunc(Number(value));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'BOOLEAN':
      return coerceLogical(value) === true;
    case 'LOGICAL':
      return coerceLogical(value) ?? undefined;
    case 'STRING':
    case 'BINARY':
      return String(value);
    default:
      return value;
  }
}
