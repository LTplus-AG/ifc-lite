/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property Extractor for IFCX
 * Extracts properties from node attributes and builds PropertyTable
 */

import type { ComposedNode } from './types.js';
import { ATTR, isTypedPropertyValue, parseV5aKey } from './types.js';
import {
  StringTable,
  PropertyTableBuilder,
  PropertyValueType,
} from '@ifc-lite/data';
import type { PropertyTable } from '@ifc-lite/data';

// Attributes to skip (not properties)
const SKIP_ATTRIBUTES: Set<string> = new Set([
  ATTR.CLASS,
  ATTR.MESH,
  ATTR.TRANSFORM,
  ATTR.VISIBILITY,
  ATTR.DIFFUSE_COLOR,
  ATTR.OPACITY,
  ATTR.MATERIAL,
]);

/**
 * Extract properties from composed IFCX nodes.
 *
 * IFCX properties are flat attributes with namespace prefixes:
 * - bsi::ifc::prop::IsExternal -> PropertySingleValue
 * - bsi::ifc::prop::Volume -> QuantitySingleValue
 *
 * We group properties by namespace prefix for PropertySet-like grouping.
 */
export function extractProperties(
  composed: Map<string, ComposedNode>,
  pathToId: Map<string, number>,
  strings: StringTable
): PropertyTable {
  const builder = new PropertyTableBuilder(strings);

  for (const node of composed.values()) {
    const expressId = pathToId.get(node.path);
    if (expressId === undefined) continue;

    // Group attributes by namespace
    const grouped = groupAttributesByNamespace(node.attributes);

    for (const [psetName, props] of grouped) {
      for (const [propName, value] of props) {
        const { propType, propValue } = convertPropertyValue(value);

        builder.add({
          entityId: expressId,
          psetName,
          psetGlobalId: '',
          propName,
          propType,
          value: propValue,
        });
      }
    }
  }

  return builder.build();
}

/**
 * Group attributes by their namespace prefix.
 * Excludes quantity-like properties (they go to QuantityTable instead).
 */
function groupAttributesByNamespace(
  attributes: Map<string, unknown>
): Map<string, Map<string, unknown>> {
  const grouped = new Map<string, Map<string, unknown>>();

  for (const [key, value] of attributes) {
    // Skip non-property attributes
    if (SKIP_ATTRIBUTES.has(key)) {
      continue;
    }

    // `ifclite::*` keys are internal carriers (deletion/derived markers,
    // collab classifications/materials/geometryRef) — never user
    // properties (#1031).
    if (key.startsWith('ifclite::')) {
      continue;
    }

    // Parse namespace::name pattern
    const lastColon = key.lastIndexOf('::');
    if (lastColon === -1) continue;

    const namespace = key.slice(0, lastColon);
    const propName = key.slice(lastColon + 2);

    // Skip quantity-routed attributes — they go to QuantityTable.
    if (routesToQuantityTable(key, value)) {
      continue;
    }

    // Use namespace as pset name, format for display
    const psetName = formatNamespace(namespace);

    if (!grouped.has(psetName)) {
      grouped.set(psetName, new Map());
    }
    grouped.get(psetName)!.set(propName, value);
  }

  return grouped;
}

/**
 * Format namespace for display as PropertySet name.
 * Maps technical namespaces to user-friendly names.
 */
function formatNamespace(namespace: string): string {
  // Map common IFC5 namespaces to user-friendly names
  const namespaceMap: Record<string, string> = {
    'bsi::ifc::prop': 'IFC Properties',
    'bsi::ifc::presentation': 'Presentation',
    'bsi::ifc::material': 'Material',
    'bsi::ifc::spaceBoundary': 'Space Boundary',
    'bsi::ifc': 'IFC',
    'usd::usdgeom': 'Geometry',
    'usd': 'USD',
  };

  // Check for exact match first
  if (namespaceMap[namespace]) {
    return namespaceMap[namespace];
  }

  // Check for prefix match (e.g., custom extensions)
  for (const [prefix, name] of Object.entries(namespaceMap)) {
    if (namespace.startsWith(prefix + '::')) {
      const suffix = namespace.slice(prefix.length + 2);
      return `${name} - ${suffix}`;
    }
  }

  // Fallback: make it readable
  // e.g., "vendor::custom::prop" -> "Vendor Custom Prop"
  return namespace
    .split('::')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Convert IFCX attribute value to PropertyTable format.
 */
function convertPropertyValue(value: unknown): {
  propType: PropertyValueType;
  propValue: string | number | boolean;
} {
  // Typed records (#1031) expose their actual scalar, not a JSON blob.
  if (isTypedPropertyValue(value)) {
    return convertPropertyValue(value.value);
  }

  if (typeof value === 'string') {
    return {
      propType: PropertyValueType.String,
      propValue: value,
    };
  }

  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return {
        propType: PropertyValueType.Integer,
        propValue: value,
      };
    }
    return {
      propType: PropertyValueType.Real,
      propValue: value,
    };
  }

  if (typeof value === 'boolean') {
    return {
      propType: PropertyValueType.Boolean,
      propValue: value,
    };
  }

  // Arrays and objects - serialize to JSON string
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    return {
      propType: PropertyValueType.String,
      propValue: JSON.stringify(value),
    };
  }

  // Null or undefined
  return {
    propType: PropertyValueType.String,
    propValue: '',
  };
}

/**
 * Extract quantity-like properties (Volume, Area, Length, etc.)
 * These are identified by their names matching quantity patterns.
 */
/**
 * Single routing rule shared by property extraction (skip) and quantity
 * building (accept). Inside the `bsi::ifc::v5a::` namespace this mirrors
 * the collab structured-branch inflation exactly, so a serialized
 * snapshot parses into the same property/quantity split it was authored
 * with (#1031): `Pset_*` members are properties no matter what they're
 * called (IFC psets legitimately hold `Length`/`Area`/… properties),
 * `Qto_*` members are quantities, and custom sets route typed records to
 * properties and raw numbers to quantities. Keys outside v5a keep the
 * legacy quantity-like-name heuristic.
 */
export function routesToQuantityTable(key: string, value: unknown): boolean {
  const effective = isTypedPropertyValue(value) ? value.value : value;
  if (typeof effective !== 'number') return false;
  const v5a = parseV5aKey(key);
  if (v5a) {
    if (v5a.setName.startsWith('Pset_')) return false;
    if (v5a.setName.startsWith('Qto_')) return true;
    return !isTypedPropertyValue(value);
  }
  return isQuantityProperty(key.split('::').pop() ?? '');
}

export function isQuantityProperty(propName: string): boolean {
  // Exact matches for common quantity names
  const exactQuantityNames = new Set([
    'Volume',
    'Area',
    'Length',
    'Width',
    'Height',
    'Depth',
    'Thickness',
    'Weight',
    'Mass',
    'Count',
    'Perimeter',
    'CrossSectionArea',
  ]);

  // Suffix patterns for compound quantity names
  const suffixPatterns = [
    'Volume',
    'Area',
    'Length',
    'Weight',
    'Mass',
    'Count',
    'Perimeter',
  ];

  // Check exact match
  if (exactQuantityNames.has(propName)) {
    return true;
  }

  // Check suffix patterns (e.g., GrossArea, NetVolume, SideArea)
  return suffixPatterns.some(pattern =>
    propName.endsWith(pattern) && propName !== pattern
  );
}
