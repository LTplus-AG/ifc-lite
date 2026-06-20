/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity retype (reassign class) materialization for STEP export.
 *
 * Mirrors IfcOpenShell's `ifcopenshell.util.schema.reassign_class`: an entity
 * keeps its expressId (so geometry / placement / representation and every
 * `IfcRel*` reference — all keyed by `#id` — carry over unchanged) while its
 * class keyword and attribute layout are swapped to the target class.
 *
 * Attributes are re-laid-out BY NAME against the target class's declared
 * attribute list:
 *   - attributes the target class doesn't declare are dropped
 *     (e.g. IFC2X3 `IfcBuildingElementProxy.CompositionType` when retyping to
 *      `IfcColumn`, which has no 9th attribute);
 *   - attributes the target declares but the source lacks become `$`;
 *   - the `PredefinedType` enum is validated against the target class's
 *     domain — an out-of-domain carried value is dropped, and an explicit
 *     out-of-domain override falls back to `USERDEFINED` + `ObjectType`.
 *
 * For the common building-element subtypes (Proxy ↔ Column / Beam / Member /
 * Plate / Wall) the IFC4 attribute layout is identical, so the re-layout is an
 * identity and only the keyword (and optionally PredefinedType) changes — the
 * raw argument tokens are preserved byte-for-byte.
 */

import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3 } from '@ifc-lite/data';
import { escapeStepString, splitTopLevelArgs } from './step-serialization.js';
import type { IfcSchemaVersion } from './schema-converter.js';

interface RetypeEntityInfo {
  readonly attributes: readonly string[];
  readonly predefinedTypes: readonly string[];
}

function buildSchemaMap(
  list: ReadonlyArray<{ name: string; attributes: readonly string[]; predefinedTypes: readonly string[] }>,
): Map<string, RetypeEntityInfo> {
  const map = new Map<string, RetypeEntityInfo>();
  for (const entity of list) {
    map.set(entity.name.toUpperCase(), {
      attributes: entity.attributes,
      predefinedTypes: entity.predefinedTypes,
    });
  }
  return map;
}

const SCHEMA_MAPS: Record<IfcSchemaVersion, Map<string, RetypeEntityInfo>> = {
  IFC2X3: buildSchemaMap(ENTITIES_IFC2X3),
  IFC4: buildSchemaMap(ENTITIES_IFC4),
  IFC4X3: buildSchemaMap(ENTITIES_IFC4X3),
  // IFC5 isn't STEP; never reached for retype, but keep the lookup total.
  IFC5: buildSchemaMap(ENTITIES_IFC4X3),
};

/**
 * Look up a class's attribute layout + PredefinedType domain for a schema.
 * Falls back to the IFC4 registry for vendor extensions absent from the
 * requested schema's bundle, then to `null` for genuinely unknown classes.
 */
function lookupEntityInfo(schema: IfcSchemaVersion, name: string): RetypeEntityInfo | null {
  const upper = name.toUpperCase();
  return SCHEMA_MAPS[schema]?.get(upper) ?? SCHEMA_MAPS.IFC4.get(upper) ?? null;
}

/** Strip the dot-wrapping from a STEP enum token: `.ELEMENT.` → `ELEMENT`. */
function enumValue(token: string): string | null {
  const t = token.trim();
  if (t.length >= 2 && t.startsWith('.') && t.endsWith('.')) {
    return t.slice(1, -1);
  }
  return null;
}

/** Normalize a caller-supplied predefined type to a bare enum symbol. */
function normalizePredefined(value: string): string {
  return (enumValue(value) ?? value).trim().toUpperCase();
}

export interface RetypeArgsResult {
  tokens: string[];
  /** True when the layout was resolved from schema; false ⇒ keyword-only swap. */
  resolved: boolean;
}

/**
 * Re-lay-out an entity's STEP argument tokens for a new class.
 *
 * `argTokens` are already-serialized STEP fragments (as produced by
 * {@link splitTopLevelArgs}). Returns a fresh token array in the target
 * class's attribute order. When source or target layout can't be resolved
 * from the schema (vendor extension, malformed), `resolved` is false and the
 * caller should fall back to a keyword-only swap.
 */
export function retypeArgTokens(
  argTokens: string[],
  sourceType: string,
  newType: string,
  predefinedType: string | null | undefined,
  schema: IfcSchemaVersion,
): RetypeArgsResult {
  const sourceInfo = lookupEntityInfo(schema, sourceType);
  const targetInfo = lookupEntityInfo(schema, newType);

  // Without both layouts we can't map by name. Fall back to keyword-only swap,
  // preserving the original argument list verbatim.
  if (!sourceInfo || !targetInfo) {
    return { tokens: argTokens.slice(), resolved: false };
  }

  // Map source attribute NAME → its serialized token.
  const byName = new Map<string, string>();
  const span = Math.min(sourceInfo.attributes.length, argTokens.length);
  for (let i = 0; i < span; i++) {
    byName.set(sourceInfo.attributes[i], argTokens[i]);
  }

  const tokens = targetInfo.attributes.map((name) => byName.get(name) ?? '$');

  const predefinedIdx = targetInfo.attributes.indexOf('PredefinedType');
  if (predefinedIdx >= 0) {
    if (predefinedType != null && predefinedType !== '') {
      const sym = normalizePredefined(predefinedType);
      if (targetInfo.predefinedTypes.includes(sym)) {
        tokens[predefinedIdx] = `.${sym}.`;
      } else {
        // Unknown enum value → USERDEFINED + carry the literal on ObjectType /
        // ElementType, mirroring IfcOpenShell's reassign_class fallback.
        tokens[predefinedIdx] = '.USERDEFINED.';
        const labelIdx = targetInfo.attributes.indexOf('ObjectType') >= 0
          ? targetInfo.attributes.indexOf('ObjectType')
          : targetInfo.attributes.indexOf('ElementType');
        if (labelIdx >= 0) {
          tokens[labelIdx] = `'${escapeStepString(predefinedType)}'`;
        }
      }
    } else {
      // No override: sanitize a carried-over enum that isn't valid for the
      // target class. PredefinedType is optional, so dropping to `$` is valid.
      const carried = enumValue(tokens[predefinedIdx]);
      if (carried !== null && !targetInfo.predefinedTypes.includes(carried)) {
        tokens[predefinedIdx] = '$';
      }
    }
  }

  return { tokens, resolved: true };
}

/**
 * Rewrite a raw STEP entity line to a new IFC class.
 *
 * `entityText` is a single STEP record (`#123=IFCFOO(...);`, possibly with a
 * trailing newline). Returns the rewritten line, or the original unchanged if
 * it can't be parsed.
 *
 * `schema` is the schema the raw text is in (the source schema). When the
 * exporter is ALSO converting to a different output schema, the retype runs
 * first in the source schema and the converter runs after. A narrow edge
 * follows from that ordering: if the target class gains a `PredefinedType`
 * slot only in the OUTPUT schema (e.g. IFC2X3 `IfcColumn` → IFC4 `IfcColumn`),
 * an explicit override has no slot to land in and is dropped. Retyping within
 * a single schema (the common case) is unaffected.
 */
export function retypeStepLine(
  entityText: string,
  sourceType: string,
  newType: string,
  predefinedType: string | null | undefined,
  schema: IfcSchemaVersion,
): string {
  const eq = entityText.indexOf('=');
  const openParen = entityText.indexOf('(');
  const closeParen = entityText.lastIndexOf(');');
  const newUpper = newType.toUpperCase();

  if (eq < 0 || openParen < eq || closeParen < openParen) {
    return entityText;
  }

  const idPrefix = entityText.slice(0, eq + 1); // "#123="
  const argTokens = splitTopLevelArgs(entityText.slice(openParen + 1, closeParen));
  const { tokens, resolved } = retypeArgTokens(argTokens, sourceType, newType, predefinedType, schema);

  if (!resolved) {
    // Keyword-only swap: keep the original argument list verbatim.
    return `${idPrefix}${newUpper}${entityText.slice(openParen)}`;
  }

  // `entityText.slice(closeParen)` keeps the closing `);` plus any trailing
  // bytes (newline) intact.
  return `${idPrefix}${newUpper}(${tokens.join(',')}${entityText.slice(closeParen)}`;
}
