/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC Schema Version Converter
 *
 * Handles entity type renaming and attribute rewriting when converting
 * between IFC schema versions (IFC2X3, IFC4, IFC4X3, IFC5).
 *
 * Key differences between schemas:
 * - IFC2X3 → IFC4: IfcWallStandardCase → IfcWall (with PredefinedType),
 *   spatial hierarchy changes, removed/renamed entity types
 * - IFC4 → IFC4X3: New facility types (bridge, road, railway, marine),
 *   IfcBuiltElement replaces IfcBuildingElement in some cases
 * - IFC5: Alpha spec — STEP-based with different attribute ordering,
 *   entity names largely aligned with IFC4X3 but schema header is 'IFC5'
 *
 * This module works at the STEP text level: it rewrites entity type names
 * and adjusts attribute counts via regex replacement on raw STEP lines.
 */

import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { deterministicGlobalId } from '@ifc-lite/parser';
import { ENTITIES_IFC2X3, ENTITIES_IFC4, ENTITIES_IFC4X3, type IfcEntityInfo } from '@ifc-lite/data';
import { resolveUnrepresentedEntity } from './schema-untranslatable.js';
import { BY_NAME_ATTR_REMAP_TYPES, remapRenamedAttributesByName } from './schema-converter-attr-remap.js';

export type IfcSchemaVersion = 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';

/**
 * Entity type name mappings between schema versions.
 *
 * Maps (sourceSchema, entityType) → targetEntityType.
 * Only entries that actually differ are listed — types that are the same
 * across all schemas are passed through unchanged.
 */

// ─── IFC2X3 → IFC4 type renames ────────────────────────────────────────────
// IFC2X3 had several *StandardCase subtypes that were folded into parent
// types in IFC4 (with PredefinedType discriminator instead).
const IFC2X3_TO_IFC4: Map<string, string> = new Map([
  // StandardCase types removed in IFC4 (kept for backwards compat but deprecated)
  // In IFC4 these are valid but deprecated; we keep them as-is.
  // Only types that were truly removed/renamed:
  ['IFCELECTRICDISTRIBUTIONPOINT', 'IFCELECTRICDISTRIBUTIONBOARD'],
  ['IFCGASTERMINALTYPE', 'IFCBURNERTYPE'],
  ['IFCEQUIPMENTELEMENT', 'IFCBUILDINGELEMENTPROXY'],
]);

// ─── IFC4 → IFC2X3 type renames (reverse) ──────────────────────────────────
const IFC4_TO_IFC2X3: Map<string, string> = new Map([
  ['IFCELECTRICDISTRIBUTIONBOARD', 'IFCELECTRICDISTRIBUTIONPOINT'],
  ['IFCBURNERTYPE', 'IFCGASTERMINALTYPE'],
  // Types added in IFC4 that have no IFC2X3 equivalent → proxy
  ['IFCCHIMNEY', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCSHADINGDEVICE', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCCIVILELEMENT', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCGEOGRAPHICELEMENT', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCBEARING', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCDEEPFOUNDATION', 'IFCFOOTING'],
  ['IFCCOURSE', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCPAVEMENT', 'IFCSLAB'],
  ['IFCKERB', 'IFCBUILDINGELEMENTPROXY'],
  // IFC4 renamed the IFC2X3 door/window type objects. Left unmapped,
  // `resolveUnrepresentedEntity` treated them as having NO IFC2X3
  // representation and replaced every one with an IFCPROXY carrying a
  // freshly minted GlobalId — losing the source GlobalId, Name and psets —
  // even though IfcDoorStyle/IfcWindowStyle are real targets. The attribute
  // lists only partially overlap, so `BY_NAME_ATTR_REMAP_TYPES`
  // (schema-converter-attr-remap.ts) also reconciles them by name.
  ['IFCDOORTYPE', 'IFCDOORSTYLE'],
  ['IFCWINDOWTYPE', 'IFCWINDOWSTYLE'],
  // IFC4X3 spatial structure → IFC2X3 equivalents
  ['IFCFACILITY', 'IFCBUILDING'],
  ['IFCFACILITYPART', 'IFCBUILDINGSTOREY'],
  ['IFCFACILITYPARTCOMMON', 'IFCBUILDINGSTOREY'],
  ['IFCBRIDGE', 'IFCBUILDING'],
  ['IFCBRIDGEPART', 'IFCBUILDINGSTOREY'],
  ['IFCROAD', 'IFCBUILDING'],
  ['IFCROADPART', 'IFCBUILDINGSTOREY'],
  ['IFCRAILWAY', 'IFCBUILDING'],
  ['IFCRAILWAYPART', 'IFCBUILDINGSTOREY'],
  ['IFCMARINEFACILITY', 'IFCBUILDING'],
  ['IFCMARINEPART', 'IFCBUILDINGSTOREY'],
  // IFC4 BuiltElement → IFC2X3 BuildingElement
  ['IFCBUILTELEMENT', 'IFCBUILDINGELEMENTPROXY'],
]);

// ─── IFC4 → IFC4X3 type renames ────────────────────────────────────────────
const IFC4_TO_IFC4X3: Map<string, string> = new Map([
  // IfcBuildingElement → IfcBuiltElement (IFC4X3 rename)
  // Note: both exist in IFC4X3 for backwards compat, but IfcBuiltElement is canonical
]);

// ─── IFC4X3 → IFC4 type renames ────────────────────────────────────────────
const IFC4X3_TO_IFC4: Map<string, string> = new Map([
  // IFC4X3-specific types that have no IFC4 equivalent → fallback
  ['IFCFACILITY', 'IFCBUILDING'],
  ['IFCFACILITYPART', 'IFCBUILDINGSTOREY'],
  ['IFCFACILITYPARTCOMMON', 'IFCBUILDINGSTOREY'],
  ['IFCBRIDGE', 'IFCBUILDING'],
  ['IFCBRIDGEPART', 'IFCBUILDINGSTOREY'],
  ['IFCROAD', 'IFCBUILDING'],
  ['IFCROADPART', 'IFCBUILDINGSTOREY'],
  ['IFCRAILWAY', 'IFCBUILDING'],
  ['IFCRAILWAYPART', 'IFCBUILDINGSTOREY'],
  ['IFCMARINEFACILITY', 'IFCBUILDING'],
  ['IFCMARINEPART', 'IFCBUILDINGSTOREY'],
  ['IFCBUILTELEMENT', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCEARTHWORKSCUT', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCEARTHWORKSELEMENT', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCEARTHWORKSFILL', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCCAISSONFOUNDATION', 'IFCFOOTING'],
  ['IFCNAVIGATIONELEMENT', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCMOORINGDEVICE', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCPAVEMENT', 'IFCSLAB'],
  ['IFCRAIL', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCREINFORCEDSOIL', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCSIGN', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCSIGNAL', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCTRACKELEMENT', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCKERB', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCCOURSE', 'IFCBUILDINGELEMENTPROXY'],
  ['IFCLINEARPOSITIONINGELEMENT', 'IFCPROXY'],
  ['IFCPOSITIONINGELEMENT', 'IFCPROXY'],
  ['IFCREFERENT', 'IFCPROXY'],
  ['IFCALIGNMENT', 'IFCPROXY'],
  ['IFCLINEARELEMENT', 'IFCPROXY'],
  ['IFCCONVEYORSEGMENT', 'IFCFLOWSEGMENT'],
  ['IFCLIQUIDTERMINAL', 'IFCFLOWTERMINAL'],
  ['IFCMOBILETELECOMMUNICATIONSAPPLIANCE', 'IFCCOMMUNICATIONSAPPLIANCE'],
  ['IFCDISTRIBUTIONBOARD', 'IFCELECTRICDISTRIBUTIONBOARD'],
  ['IFCELECTRICFLOWTREATMENTDEVICE', 'IFCFLOWTREATMENTDEVICE'],
]);

/**
 * Convert an entity type name from one IFC schema version to another.
 *
 * @param entityType - UPPERCASE entity type name (e.g., 'IFCWALL')
 * @param fromSchema - Source schema version
 * @param toSchema - Target schema version
 * @returns The mapped entity type name, or the original if no mapping needed
 */
export function convertEntityType(
  entityType: string,
  fromSchema: IfcSchemaVersion,
  toSchema: IfcSchemaVersion,
): string {
  if (fromSchema === toSchema) return entityType;

  const upper = entityType.toUpperCase();

  // Get the conversion map for this direction
  const map = getConversionMap(fromSchema, toSchema);
  return map?.get(upper) ?? upper;
}

/**
 * Get the appropriate conversion map for a schema transition.
 * For multi-step conversions (e.g., IFC2X3 → IFC4X3), chains maps.
 */
function getConversionMap(
  from: IfcSchemaVersion,
  to: IfcSchemaVersion,
): Map<string, string> | null {
  // Direct conversions
  if (from === 'IFC2X3' && to === 'IFC4') return IFC2X3_TO_IFC4;
  if (from === 'IFC4' && to === 'IFC2X3') return IFC4_TO_IFC2X3;
  if (from === 'IFC4' && to === 'IFC4X3') return IFC4_TO_IFC4X3;
  if (from === 'IFC4X3' && to === 'IFC4') return IFC4X3_TO_IFC4;

  // IFC5 is largely aligned with IFC4X3 for entity naming
  if (from === 'IFC5' && to === 'IFC4X3') return null; // same names
  if (from === 'IFC4X3' && to === 'IFC5') return null; // same names
  if (from === 'IFC5' && to === 'IFC4') return IFC4X3_TO_IFC4;
  if (from === 'IFC4' && to === 'IFC5') return IFC4_TO_IFC4X3;

  // Multi-step: IFC2X3 → IFC4X3 = IFC2X3 → IFC4 → IFC4X3
  if (from === 'IFC2X3' && (to === 'IFC4X3' || to === 'IFC5')) {
    return chainMaps(IFC2X3_TO_IFC4, IFC4_TO_IFC4X3);
  }

  // Multi-step: IFC4X3 → IFC2X3 = IFC4X3 → IFC4 → IFC2X3
  if ((from === 'IFC4X3' || from === 'IFC5') && to === 'IFC2X3') {
    return chainMaps(IFC4X3_TO_IFC4, IFC4_TO_IFC2X3);
  }

  return null;
}

/**
 * Chain two conversion maps: apply map1 first, then map2 on the result.
 */
function chainMaps(
  map1: Map<string, string>,
  map2: Map<string, string>,
): Map<string, string> {
  const result = new Map<string, string>();

  // All entries from map1, potentially chained through map2
  for (const [key, intermediate] of map1) {
    result.set(key, map2.get(intermediate) ?? intermediate);
  }

  // Entries from map2 that aren't already covered by map1
  for (const [key, value] of map2) {
    if (!result.has(key)) {
      result.set(key, value);
    }
  }

  return result;
}

// Lazily-built UPPERCASE entity name → ordered positional attribute NAMES, per
// schema, from the generated buildingSMART tables. `IfcEntityInfo.attributes` is
// the full inherited+direct positional list (verified to match STEP counts:
// IfcWall 8→9, IfcDoor 10→13, IfcMaterial 1→3, …).
const ATTR_NAME_TABLES = new Map<IfcSchemaVersion, Map<string, readonly string[]>>();
function attrNameTable(schema: IfcSchemaVersion): Map<string, readonly string[]> | null {
  let table = ATTR_NAME_TABLES.get(schema);
  if (table) return table;
  let entities: readonly IfcEntityInfo[] | null = null;
  if (schema === 'IFC2X3') entities = ENTITIES_IFC2X3;
  else if (schema === 'IFC4') entities = ENTITIES_IFC4;
  else if (schema === 'IFC4X3') entities = ENTITIES_IFC4X3;
  else return null; // IFC5 has no generated table — skip count adjustment
  table = new Map<string, readonly string[]>();
  for (const e of entities) table.set(e.name.toUpperCase(), e.attributes);
  ATTR_NAME_TABLES.set(schema, table);
  return table;
}

/**
 * True when `shorter` is a STRICT prefix of `longer` by attribute name — i.e.
 * the longer form only *appended* attributes to the shorter one. Both the
 * trailing-`$` padding (upgrade) and the tail trim (downgrade) are only safe
 * then; many entities insert/reorder attributes mid-list (e.g.
 * IfcMaterialProperties, IfcApproval, IfcTask), where padding or trimming would
 * shift values into the wrong slots.
 *
 * Callers pass the shorter schema's list first, whichever direction they run in.
 */
function isStrictAttrPrefix(shorter: readonly string[], longer: readonly string[]): boolean {
  if (shorter.length >= longer.length) return false;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) return false;
  }
  return true;
}

/** Count top-level (comma-separated) STEP attributes, respecting nested
 *  parentheses and single-quoted strings. Empty list → 0. */
function countTopLevelAttributes(attrsRaw: string): number {
  if (!attrsRaw.trim()) return 0;
  let count = 1;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < attrsRaw.length; i++) {
    const ch = attrsRaw[i];
    if (ch === "'" && !inString) inString = true;
    else if (ch === "'" && inString) {
      if (i + 1 < attrsRaw.length && attrsRaw[i + 1] === "'") { i++; continue; }
      inString = false;
    } else if (!inString) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) count++;
    }
  }
  return count;
}

/**
 * Convert a raw STEP entity line from one schema version to another.
 *
 * Handles:
 * 1. Entity type name conversion
 * 2. Attribute count adjustment: trimming trailing attrs for older schemas, and
 *    padding trailing `$` for newer schemas that ADDED attributes (e.g. the
 *    PredefinedType IFC4 introduced on IfcWall/IfcBeam/IfcOpeningElement/…).
 * 3. Skipping entities that have no valid representation in the target schema
 *
 * @param line - Raw STEP entity line (e.g., "#1=IFCWALL('guid',...);")
 * @param fromSchema - Source schema version
 * @param toSchema - Target schema version
 * @param random - Optional seeded `RandomSource` for the GlobalId of any
 *   IFCPROXY placeholder minted here. Omit for the default random path; pass
 *   a seeded source when the caller needs byte-reproducible output.
 * @returns Converted line (entities without valid target representation become IFCPROXY placeholders)
 */
export function convertStepLine(
  line: string,
  fromSchema: IfcSchemaVersion,
  toSchema: IfcSchemaVersion,
  random?: RandomSource,
): string {
  if (fromSchema === toSchema) return line;

  // Parse: #ID=TYPE(attrs);  — tolerate whitespace around `=` and before the
  // type (some exporters, e.g. Tekla, write `#34498= IFCOPENINGELEMENT(...)`).
  // Without this those lines passed through unconverted, so neither type renames
  // nor attribute-count adjustment applied and the output stayed schema-invalid.
  const match = line.match(/^\s*(#\d+=)\s*(\w+)\((.*)?\);?\s*$/);
  if (!match) return line; // not a STEP entity line, pass through

  const prefix = match[1];  // "#123="
  const entityType = match[2].toUpperCase();
  const attrsRaw = match[3] ?? '';

  // Convert entity type
  const newType = convertEntityType(entityType, fromSchema, toSchema);

  // Replace entities that have no valid representation in the target schema
  // with IFCPROXY placeholders to preserve EXPRESS IDs and prevent dangling references
  if (shouldSkipEntity(newType, toSchema)) {
    // Derive the placeholder's GlobalId from the source line rather than
    // minting a random one (#2733). Every downgraded entity used to get a
    // FRESH id on every export, so exporting an unchanged IFC4X3 model twice
    // never produced the same bytes: 116 differing lines, 58 of them IFCPROXY,
    // at identical byte size, which is the signature of
    // same-shape-different-identifier.
    //
    // Reusing the SOURCE entity's own GlobalId looks like the obvious fix and
    // is wrong. `merged-exporter.test.ts` pins the case: two federated models
    // legitimately carry the same alignment GlobalId, and a fresh id per
    // occurrence is what stops them being unified into one. Copying the source
    // id would silently collapse two alignments into one.
    //
    // Seeding from the whole line satisfies both. Re-exporting an unchanged
    // model reproduces the line and so the id; two federated occurrences differ
    // because the merged exporter offsets each model's express ids, so their
    // `prefix` differs. Same primitive and same reasoning as `mintUniqueGuid`
    // in merged-exporter.ts, which seeds from the original id plus the model's
    // stable id.
    //
    // A caller-supplied seeded source still wins, so an export that already
    // pins its randomness keeps its existing behaviour.
    const guid = random
      ? generateIfcGuid(random)
      : deterministicGlobalId(`ifcproxy:${prefix}${entityType}(${attrsRaw})`);
    return `${prefix}IFCPROXY('${guid}',$,'${entityType}',$,$,$,$,.NOTDEFINED.,$);`;
  }

  // Reconcile the attribute list against the target schema. WHICH WAY it moves
  // is decided by the strict attribute-NAME prefix relation alone, never by the
  // direction of travel — rank and shrinkage are independent. A newer schema can
  // REMOVE attributes: 10 entities have an IFC4 list that is a strict prefix of
  // their IFC2X3 one, and 4 more for IFC4 → IFC4X3. IFC4 dropped
  // `ControlElementId` from IfcDistributionControlElement and both
  // `CentreOfGravity*` from IfcLShapeProfileDef; IFC4X3 dropped IfcReferent's
  // `PredefinedType`. Gating the trim on the rank comparison left every one of
  // those upgrades untouched, so 6-argument `IFCRELDECOMPOSES` lines — the
  // entity takes 4 in IFC4 — went into files whose header declares IFC4.
  //
  // The prefix rule is what makes either adjustment safe: many entities INSERT
  // attributes mid-list rather than appending them (IFC2X3 IfcApproval is
  // [Description, ApprovalDateTime, …, Identifier] against IFC4's
  // [Identifier, Name, Description, …]; IfcMaterialProperties [Material] →
  // [Name, Description, Properties, Material]), and trimming the tail or
  // appending `$` there would leave values in the wrong, type-invalid slots.
  // Those types are left alone. The appended attributes are optional, so `$` is
  // a valid pad.
  //
  // The two branches cannot both apply: each requires ITS OWN list to be
  // strictly shorter than the other, which no pair of lists can satisfy at once.
  // Source attrs keyed on the ORIGINAL type; target on the (possibly renamed) type.
  let finalAttrs = attrsRaw;
  const targetTable = attrNameTable(toSchema);
  const srcAttrs = attrNameTable(fromSchema)?.get(entityType);
  const tgtAttrs = targetTable?.get(newType);
  // `shouldSkipEntity` above only catches its hand-listed alignment types;
  // a type entirely unknown to `targetTable` (not merely a strict-prefix
  // attribute mismatch, handled below) has no representation in `toSchema` at
  // all — see `resolveUnrepresentedEntity` for why it can't just pass through.
  if (srcAttrs && targetTable && !tgtAttrs) {
    return resolveUnrepresentedEntity(prefix, entityType, attrsRaw, toSchema, random);
  }
  if (srcAttrs && tgtAttrs) {
    if (isStrictAttrPrefix(tgtAttrs, srcAttrs)) {
      finalAttrs = trimAttributes(attrsRaw, tgtAttrs.length);
    } else if (isStrictAttrPrefix(srcAttrs, tgtAttrs)) {
      const currentCount = countTopLevelAttributes(finalAttrs);
      if (currentCount > 0 && currentCount < tgtAttrs.length) {
        finalAttrs = `${finalAttrs}${',$'.repeat(tgtAttrs.length - currentCount)}`;
      }
    } else if (entityType !== newType && BY_NAME_ATTR_REMAP_TYPES.has(entityType)) {
      // Neither list is a prefix of the other; see `BY_NAME_ATTR_REMAP_TYPES`.
      finalAttrs = remapRenamedAttributesByName(attrsRaw, srcAttrs, tgtAttrs);
    }
  }

  return `${prefix}${newType}(${finalAttrs});`;
}

/**
 * Check if an entity type should be skipped for the target schema.
 * Some IFC4X3 types (alignment, positioning) have no valid STEP representation
 * in older schemas even as proxies.
 *
 * Alignment entities are valid in IFC4X3 and IFC5, so they are only skipped
 * when targeting older schemas (IFC2X3, IFC4).
 */
function shouldSkipEntity(entityType: string, toSchema: IfcSchemaVersion): boolean {
  // Alignment entities are native to IFC4X3 and IFC5 — preserve them
  if (toSchema === 'IFC4X3' || toSchema === 'IFC5') {
    return false;
  }

  // For older schemas, these alignment types have no meaningful representation
  const skipTypes = new Set([
    'IFCALIGNMENTCANT',
    'IFCALIGNMENTHORIZONTAL',
    'IFCALIGNMENTVERTICAL',
    'IFCALIGNMENTSEGMENT',
  ]);

  return skipTypes.has(entityType);
}

/**
 * Trim a STEP attribute list to a maximum number of attributes.
 *
 * Parses the attribute string respecting STEP nesting (parentheses, strings)
 * and returns only the first `maxCount` attributes.
 */
function trimAttributes(attrsRaw: string, maxCount: number): string {
  if (!attrsRaw.trim()) return attrsRaw;
  // The scan below only tests its budget AFTER pushing an attribute, so a zero
  // budget would keep the first one. An entity with no attributes in the target
  // schema keeps none.
  if (maxCount <= 0) return '';

  const attrs: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';

  for (let i = 0; i < attrsRaw.length; i++) {
    const ch = attrsRaw[i];

    if (ch === "'" && !inString) {
      inString = true;
      current += ch;
    } else if (ch === "'" && inString) {
      // Check for escaped quote ''
      if (i + 1 < attrsRaw.length && attrsRaw[i + 1] === "'") {
        current += "''";
        i++;
        continue;
      }
      inString = false;
      current += ch;
    } else if (inString) {
      current += ch;
    } else if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      attrs.push(current);
      current = '';
      if (attrs.length >= maxCount) {
        return attrs.join(',');
      }
    } else {
      current += ch;
    }
  }

  // Last attribute
  attrs.push(current);

  // Trim to maxCount
  if (attrs.length > maxCount) {
    return attrs.slice(0, maxCount).join(',');
  }

  return attrs.join(',');
}

/**
 * Check if a conversion between two schema versions requires entity type changes.
 */
export function needsConversion(
  fromSchema: IfcSchemaVersion,
  toSchema: IfcSchemaVersion,
): boolean {
  return fromSchema !== toSchema;
}

/**
 * Get human-readable description of what a conversion entails.
 */
export function describeConversion(
  fromSchema: IfcSchemaVersion,
  toSchema: IfcSchemaVersion,
): string {
  if (fromSchema === toSchema) return 'No conversion needed';

  const warnings: string[] = [];

  if (toSchema === 'IFC2X3') {
    warnings.push('Entities not in IFC2X3 will be mapped to IfcBuildingElementProxy');
    warnings.push('Extra attributes (e.g., PredefinedType) will be trimmed');
  }

  if (toSchema === 'IFC5') {
    warnings.push('IFC5 is alpha/incomplete — exported files may not validate against final spec');
  }

  if (fromSchema === 'IFC4X3' && (toSchema === 'IFC4' || toSchema === 'IFC2X3')) {
    warnings.push('IFC4X3 facility types (Bridge, Road, Railway) will be mapped to Building/Storey');
  }

  return warnings.length > 0
    ? `Converting ${fromSchema} → ${toSchema}: ${warnings.join('; ')}`
    : `Converting ${fromSchema} → ${toSchema}`;
}

