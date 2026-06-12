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

import { generateIfcGuid } from '@ifc-lite/encoding';

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
 * IFC2X3 entities that have fewer attributes than IFC4.
 * When converting IFC4 → IFC2X3, trailing attributes must be trimmed.
 *
 * Key: entity type (UPPERCASE)
 * Value: max number of positional attributes allowed in IFC2X3
 *
 * Common differences:
 * - IfcRoot subtypes: IFC4 adds no extra root attrs, but several element
 *   subtypes gained PredefinedType in IFC4 that doesn't exist in IFC2X3.
 * - IfcProject: IFC2X3 has 9 attrs, IFC4 has 9 (same)
 * - IfcSite: IFC2X3 has 14, IFC4 has 14 (same)
 * - IfcBuilding: IFC2X3 has 12, IFC4 has 12 (same)
 * - IfcBuildingStorey: IFC2X3 has 10, IFC4 has 10 (same)
 * - IfcSpace: IFC2X3 has 11 (no LongName), IFC4 has 11 (same count, different attrs)
 * - IfcWall: IFC2X3 has 8, IFC4 has 9 (added PredefinedType)
 * - IfcSlab: IFC2X3 has 9, IFC4 has 9 (same)
 * - IfcDoor: IFC2X3 has 10, IFC4 has 13 (added PredefinedType, OperationType, UserDefinedOperationType)
 * - IfcWindow: IFC2X3 has 10, IFC4 has 13 (added PredefinedType, PartitioningType, UserDefinedPartitioningType)
 * - IfcBeam/Column: IFC2X3 has 8, IFC4 has 9 (added PredefinedType)
 * - IfcOpeningElement: IFC2X3 has 8, IFC4 has 9 (added PredefinedType)
 */
const IFC2X3_ATTR_COUNTS: Map<string, number> = new Map([
  ['IFCWALL', 8],
  ['IFCBEAM', 8],
  ['IFCCOLUMN', 8],
  ['IFCROOF', 9],
  ['IFCSTAIR', 9],
  ['IFCRAMP', 9],
  ['IFCRAILING', 9],
  ['IFCMEMBER', 8],
  ['IFCPLATE', 8],
  ['IFCFOOTING', 9],
  ['IFCPILE', 11],
  ['IFCCOVERING', 9],
  ['IFCOPENINGELEMENT', 8],
  ['IFCDOOR', 10],
  ['IFCWINDOW', 10],
  ['IFCFURNISHINGELEMENT', 8],
  ['IFCBUILDINGELEMENTPROXY', 9],
  ['IFCCURTAINWALL', 8],
  ['IFCFLOWSEGMENT', 8],
  ['IFCFLOWTERMINAL', 8],
  ['IFCFLOWCONTROLLER', 8],
  ['IFCFLOWFITTING', 8],
  ['IFCFLOWMOVINGDEVICE', 8],
  ['IFCFLOWSTORAGEDEVICE', 8],
  ['IFCFLOWTREATMENTDEVICE', 8],
  ['IFCENERGYCONVERSIONDEVICE', 8],
  ['IFCDISTRIBUTIONELEMENT', 8],
  ['IFCDISTRIBUTIONFLOWELEMENT', 8],
  ['IFCDISTRIBUTIONCONTROLELEMENT', 8],
  ['IFCDISTRIBUTIONCHAMBERELEMENT', 8],
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

/**
 * Convert a raw STEP entity line from one schema version to another.
 *
 * Handles:
 * 1. Entity type name conversion
 * 2. Attribute count adjustment (trimming trailing attrs for older schemas)
 * 3. Skipping entities that have no valid representation in the target schema
 *
 * @param line - Raw STEP entity line (e.g., "#1=IFCWALL('guid',...);")
 * @param fromSchema - Source schema version
 * @param toSchema - Target schema version
 * @returns Converted line (entities without valid target representation become IFCPROXY placeholders)
 */
export function convertStepLine(
  line: string,
  fromSchema: IfcSchemaVersion,
  toSchema: IfcSchemaVersion,
): string {
  if (fromSchema === toSchema) return line;

  // Parse: #ID=TYPE(attrs);
  const match = line.match(/^(#\d+=)(\w+)\((.*)?\);?\s*$/);
  if (!match) return line; // not a STEP entity line, pass through

  const prefix = match[1];  // "#123="
  const entityType = match[2].toUpperCase();
  const attrsRaw = match[3] ?? '';

  // Convert entity type
  const newType = convertEntityType(entityType, fromSchema, toSchema);

  // Replace entities that have no valid representation in the target schema
  // with IFCPROXY placeholders to preserve EXPRESS IDs and prevent dangling references
  if (shouldSkipEntity(newType, toSchema)) {
    return `${prefix}IFCPROXY('${generateIfcGuid()}',$,'${entityType}',$,$,$,$,.NOTDEFINED.,$);`;
  }

  // Adjust attribute count if downgrading to IFC2X3
  let finalAttrs = attrsRaw;
  if (toSchema === 'IFC2X3') {
    const maxAttrs = IFC2X3_ATTR_COUNTS.get(newType);
    if (maxAttrs !== undefined) {
      finalAttrs = trimAttributes(attrsRaw, maxAttrs);
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

