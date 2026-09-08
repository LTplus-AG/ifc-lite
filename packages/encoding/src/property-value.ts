/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Result of parsing a property value.
 * Contains the display value and optional IFC type for tooltip.
 */
export interface ParsedPropertyValue {
  displayValue: string;
  ifcType?: string;
}

/**
 * Map of IFC boolean enumeration values to human-readable text
 */
const BOOLEAN_MAP: Record<string, string> = {
  '.T.': 'True',
  '.F.': 'False',
  '.U.': 'Unknown',
};

/**
 * Friendly names for common IFC types (shown in tooltips)
 */
const IFC_TYPE_DISPLAY_NAMES: Record<string, string> = {
  'IFCBOOLEAN': 'Boolean',
  'IFCLOGICAL': 'Logical',
  'IFCIDENTIFIER': 'Identifier',
  'IFCLABEL': 'Label',
  'IFCTEXT': 'Text',
  'IFCREAL': 'Real',
  'IFCINTEGER': 'Integer',
  'IFCPOSITIVELENGTHMEASURE': 'Length',
  'IFCLENGTHMEASURE': 'Length',
  'IFCAREAMEASURE': 'Area',
  'IFCVOLUMEMEASURE': 'Volume',
  'IFCMASSMEASURE': 'Mass',
  'IFCTHERMALTRANSMITTANCEMEASURE': 'Thermal Transmittance',
  'IFCPRESSUREMEASURE': 'Pressure',
  'IFCFORCEMEASURE': 'Force',
  'IFCPLANEANGLEMEASURE': 'Angle',
  'IFCTIMEMEASURE': 'Time',
  'IFCNORMALISEDRATIOMEASURE': 'Ratio',
  'IFCRATIOMEASURE': 'Ratio',
  'IFCPOSITIVERATIOMEASURE': 'Ratio',
  'IFCCOUNTMEASURE': 'Count',
  'IFCMONETARYMEASURE': 'Currency',
};

/**
 * Parse and format a property value for display.
 * Handles:
 * - TypedValues like [IFCIDENTIFIER, '100 x 150mm'] -> display '100 x 150mm', tooltip 'Identifier'
 * - Boolean enums like '.T.' -> 'True'
 * - Null/undefined -> '\u2014'
 * - Regular values -> string conversion
 *
 * It deliberately does NOT decode STEP escapes. Every producer of a property
 * value decodes exactly once, at parse time: the TypeScript path via
 * `EntityExtractor.parseAttributeValue` / `columnar-parser-attributes.ts`, the
 * Rust/WASM and server paths via `AttributeValue::from_token`. The input here
 * is therefore already literal text, and decoding a second time is not a no-op
 * \u2014 since #2394 `decodeIfcString` collapses `\\` to `\`, so an authored UNC
 * path `\\server\share` would render as `\server\share`. `C:\temp` is a fixed
 * point of the decoder, which is why the defect hides on the common case.
 *
 * Making the decoder idempotent instead would not work: idempotence requires
 * treating an already-decoded `\` and an authored, still-doubled `\\` the same
 * way, which is exactly the ambiguity the one-decode rule removes. The
 * invariant to hold is "decode once, at the parse boundary", not "decode
 * defensively wherever a string is displayed".
 */
export function parsePropertyValue(value: unknown): ParsedPropertyValue {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return { displayValue: '\u2014' };
  }

  // Handle typed value arrays [IFCTYPENAME, actualValue]
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string') {
    const [ifcType, innerValue] = value;
    const typeName = ifcType.toUpperCase();
    const friendlyType = IFC_TYPE_DISPLAY_NAMES[typeName] || typeName.replace(/^IFC/, '');

    // Recursively parse the inner value
    const parsed = parsePropertyValue(innerValue);
    return {
      displayValue: parsed.displayValue,
      ifcType: friendlyType,
    };
  }

  // Handle boolean enumeration values
  if (typeof value === 'string') {
    const upperVal = value.toUpperCase();
    if (BOOLEAN_MAP[upperVal]) {
      return { displayValue: BOOLEAN_MAP[upperVal], ifcType: 'Boolean' };
    }

    // Handle string that contains typed value pattern (from String(array) conversion)
    // Pattern: "IFCTYPENAME,actualValue" or just "IFCTYPENAME," (empty value)
    const typedMatch = value.match(/^(IFC[A-Z0-9_]+),(.*)$/i);
    if (typedMatch) {
      const [, ifcType, innerValue] = typedMatch;
      const typeName = ifcType.toUpperCase();
      const friendlyType = IFC_TYPE_DISPLAY_NAMES[typeName] || typeName.replace(/^IFC/, '');

      // Handle empty value after type
      if (!innerValue || innerValue.trim() === '') {
        return { displayValue: '\u2014', ifcType: friendlyType };
      }

      // Check if the inner value is a boolean
      const upperInner = innerValue.toUpperCase().trim();
      if (BOOLEAN_MAP[upperInner]) {
        return { displayValue: BOOLEAN_MAP[upperInner], ifcType: friendlyType };
      }

      // Already decoded by the parse path (see the note on this function).
      return { displayValue: innerValue, ifcType: friendlyType };
    }

    // Already decoded by the parse path (see the note on this function).
    return { displayValue: value };
  }

  // Handle native booleans
  if (typeof value === 'boolean') {
    return { displayValue: value ? 'True' : 'False', ifcType: 'Boolean' };
  }

  // Handle numbers
  if (typeof value === 'number') {
    const formatted = Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 6 });
    return { displayValue: formatted };
  }

  // Fallback for other types
  return { displayValue: String(value) };
}
