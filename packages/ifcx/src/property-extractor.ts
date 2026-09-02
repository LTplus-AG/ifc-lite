/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Property Extractor for IFCX
 * Extracts properties from node attributes and builds PropertyTable
 */

import type { ComposedNode } from './types.js';
import { ATTR, IFCLITE_ATTR, isTypedPropertyValue, parseV5aKey } from './types.js';
import {
  StringTable,
  PropertyTableBuilder,
  PropertyValueType,
} from '@ifc-lite/data';
import type { PropertyTable } from '@ifc-lite/data';

// Attributes to skip (not properties). `ATTR.MATERIAL` is deliberately NOT
// here: `bsi::ifc::material` ({code, uri}) is the only channel IFCX carries
// an element's material on (buildingSMART's PCERT sample scenes author it on
// most physical elements), and it gets unpacked into its own "Material" pset
// below rather than treated as graph structure like CLASS/MESH/TRANSFORM.
const SKIP_ATTRIBUTES: Set<string> = new Set([
  ATTR.CLASS,
  ATTR.MESH,
  ATTR.TRANSFORM,
  ATTR.VISIBILITY,
  ATTR.DIFFUSE_COLOR,
  ATTR.OPACITY,
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

    // `ifclite::classifications` is the one `ifclite::*` carrier with no
    // spec-defined IFCX home to unpack from instead — unlike material,
    // there is no `bsi::ifc::classification` in the v5a schema (#3608).
    // Reading it back as real, queryable properties (instead of silently
    // dropping it the way the blanket `ifclite::` skip below would) is
    // what makes STEP -> IFCX -> re-import actually round-trip a
    // classification, not just STEP -> IFCX -> the collab snapshot layer.
    // One "Classification" pset per system, mirroring the Material unpack
    // below; a ref with no `code` carries nothing to show and is skipped.
    //
    // Ordinary Uniclass practice puts two refs under one system on the
    // same element (a Systems code and a Products code) — `set()`-ing a
    // single 'Code'/'Uri' pair per system would collapse them, dropping
    // one code and pairing the survivor with the wrong URI. So refs are
    // grouped by system first; a system with exactly one ref keeps the
    // plain `Classification - <system>` name (the common case looks
    // unchanged), while a system with more than one ref disambiguates
    // each into its own `Classification - <system> - <code>` pset so
    // every ref keeps its own Code/Uri pairing.
    if (key === IFCLITE_ATTR.CLASSIFICATIONS && Array.isArray(value)) {
      const bySystem = new Map<
        string,
        Array<{ code: string; uri?: string; description?: string }>
      >();
      for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const ref = item as { system?: unknown; code?: unknown; uri?: unknown; description?: unknown };
        if (typeof ref.code !== 'string' || !ref.code) continue;
        const system = typeof ref.system === 'string' && ref.system ? ref.system : '';
        if (!bySystem.has(system)) bySystem.set(system, []);
        bySystem.get(system)!.push({
          code: ref.code,
          uri: typeof ref.uri === 'string' ? ref.uri : undefined,
          description: typeof ref.description === 'string' ? ref.description : undefined,
        });
      }

      for (const [system, refs] of bySystem) {
        const multiple = refs.length > 1;
        for (const ref of refs) {
          const baseName = system
            ? multiple
              ? `Classification - ${system} - ${ref.code}`
              : `Classification - ${system}`
            : multiple
              ? `Classification - ${ref.code}`
              : 'Classification';
          // The constructed name space can collide: a system literally named
          // "Acme - A" clashes with system "Acme" + code "A", and two refs
          // sharing both system and code map to the same name. Reusing the
          // existing map would overwrite its Code and pair it with the other
          // ref's Uri, so a colliding name takes a deterministic " (n)"
          // discriminator (insertion order fixes n) and keeps its own pairing.
          let psetName = baseName;
          for (let n = 2; grouped.has(psetName); n++) {
            psetName = `${baseName} (${n})`;
          }
          grouped.set(psetName, new Map());
          const classificationProps = grouped.get(psetName)!;
          classificationProps.set('Code', ref.code);
          if (ref.uri !== undefined) classificationProps.set('Uri', ref.uri);
          if (ref.description !== undefined) classificationProps.set('Description', ref.description);
        }
      }
      continue;
    }

    // Remaining `ifclite::*` keys are internal carriers (deletion/derived
    // markers, collab materials/geometryRef/provenance) — never user
    // properties (#1031).
    if (key.startsWith('ifclite::')) {
      continue;
    }

    // `bsi::ifc::material` is a leaf attribute in its own right (an
    // {code, uri} reference), not a `namespace::name` pair — the generic
    // split below would slice it into namespace `bsi::ifc` / name
    // `material` and bury it in the catch-all "IFC" pset as a JSON blob.
    // Unpack it into its own "Material" pset instead, mirroring how a
    // STEP-sourced model surfaces IfcMaterial.Name via IfcRelAssociatesMaterial.
    if (key === ATTR.MATERIAL && value && typeof value === 'object' && !Array.isArray(value)) {
      const material = value as { code?: unknown; uri?: unknown };
      const psetName = formatNamespace(key);
      if (!grouped.has(psetName)) {
        grouped.set(psetName, new Map());
      }
      const materialProps = grouped.get(psetName)!;
      if (typeof material.code === 'string') {
        materialProps.set('Material', material.code);
      }
      if (typeof material.uri === 'string') {
        materialProps.set('Uri', material.uri);
      }
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

    // v5a keys carry the authored set name (`Pset_WallCommon`) — keep it
    // exact so consumers that match on real IFC pset names (e.g.
    // whereProperty) find these properties, mirroring the quantity
    // extractor. Other namespaces keep the display formatting.
    const v5a = parseV5aKey(key);
    const psetName = v5a ? v5a.setName : formatNamespace(namespace);
    const memberName = v5a ? v5a.name : propName;

    if (!grouped.has(psetName)) {
      grouped.set(psetName, new Map());
    }
    grouped.get(psetName)!.set(memberName, value);
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
