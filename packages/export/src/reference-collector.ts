/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reference collector for IFC STEP export filtering.
 *
 * Walks #ID references transitively from a set of root entities to build
 * the complete closure of all entities that must be included for a valid
 * STEP file. Used for visible-only export and merged export.
 *
 * KEY DESIGN: In IFC STEP files, the reference graph is:
 *   - Products reference geometry (Product → Placement → CartesianPoint)
 *   - Relationships reference products (Rel → Product, NOT Product → Rel)
 *   - Properties are reached via relationships (Rel → PropertySet → Property)
 *
 * For visible-only export, we need:
 *   1. Infrastructure + spatial structure (always included)
 *   2. Visible product entities (checked against hidden/isolated)
 *   3. Relationship entities (always included as roots — they reference products)
 *   4. Forward closure from the above roots pulls in geometry, properties, etc.
 *   5. Hidden product IDs are BLOCKED during the closure walk so their
 *      exclusively-referenced geometry doesn't get pulled in.
 *   6. IfcStyledItem entities are collected in a reverse pass after the closure
 *      because they reference geometry but nothing references them back.
 *   7. Openings whose parent element is hidden are also excluded
 *      (via IfcRelVoidsElement propagation).
 */

import type { IfcDataStore } from '@ifc-lite/parser';

/** ASCII code points for byte-level scanning. */
const HASH = 0x23;  // '#'
const ZERO = 0x30;  // '0'
const NINE = 0x39;  // '9'
const QUOTE = 0x27; // "'"

/** Entity types that form the shared file infrastructure and must always be included. */
const INFRASTRUCTURE_TYPES = new Set([
  'IFCOWNERHISTORY',
  'IFCAPPLICATION',
  'IFCPERSON',
  'IFCORGANIZATION',
  'IFCPERSONANDORGANIZATION',
  'IFCUNITASSIGNMENT',
  'IFCSIUNIT',
  'IFCDERIVEDUNIT',
  'IFCDERIVEDUNITELEMENT',
  'IFCCONVERSIONBASEDUNIT',
  'IFCMEASUREWITHUNIT',
  'IFCDIMENSIONALEXPONENTS',
  'IFCMONETARYUNIT',
  'IFCGEOMETRICREPRESENTATIONCONTEXT',
  'IFCGEOMETRICREPRESENTATIONSUBCONTEXT',
]);

/**
 * Spatial structure entity types — always included as roots.
 * Covers IFC4 and IFC4X3 (bridges, roads, railways, marine facilities).
 * Derived from all subtypes of IfcSpatialElement in the IFC schema,
 * excluding IfcSpace (which users can toggle visibility on).
 */
const SPATIAL_STRUCTURE_TYPES = new Set([
  'IFCPROJECT',
  // IFC4 spatial structure
  'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY',
  // IFC4X3 spatial structure (subtypes of IfcFacility / IfcSpatialElement)
  'IFCBRIDGE', 'IFCBRIDGEPART',
  'IFCFACILITY', 'IFCFACILITYPART', 'IFCFACILITYPARTCOMMON',
  'IFCMARINEFACILITY', 'IFCMARINEPART',
  'IFCRAILWAY', 'IFCRAILWAYPART',
  'IFCROAD', 'IFCROADPART',
  // Abstract spatial types (rarely instantiated but handle gracefully)
  'IFCSPATIALELEMENT', 'IFCSPATIALSTRUCTUREELEMENT', 'IFCSPATIALZONE',
  'IFCEXTERNALSPATIALELEMENT', 'IFCEXTERNALSPATIALSTRUCTUREELEMENT',
]);

/**
 * Complete set of all IfcProduct subtypes from the IFC4 + IFC4X3 schemas,
 * excluding spatial structure types (handled above). Generated from the
 * schema registry's inheritanceChain metadata.
 *
 * 202 types — full IFC schema coverage. The hiddenIds fallback below
 * catches any types that may exist in future schema versions.
 */
const PRODUCT_TYPES = new Set([
  // IfcElement > IfcBuildingElement
  'IFCBEAM', 'IFCBEAMSTANDARDCASE', 'IFCBUILDINGELEMENT',
  'IFCBUILDINGELEMENTPART', 'IFCBUILDINGELEMENTPROXY', 'IFCBUILTELEMENT',
  'IFCCHIMNEY', 'IFCCOLUMN', 'IFCCOLUMNSTANDARDCASE',
  'IFCCOVERING', 'IFCCURTAINWALL',
  'IFCDEEPFOUNDATION', 'IFCDOOR', 'IFCDOORSTANDARDCASE',
  'IFCFOOTING', 'IFCMEMBER', 'IFCMEMBERSTANDARDCASE',
  'IFCPILE', 'IFCPLATE', 'IFCPLATESTANDARDCASE',
  'IFCRAILING', 'IFCRAMP', 'IFCRAMPFLIGHT',
  'IFCROOF', 'IFCSHADINGDEVICE',
  'IFCSLAB', 'IFCSLABELEMENTEDCASE', 'IFCSLABSTANDARDCASE',
  'IFCSTAIR', 'IFCSTAIRFLIGHT',
  'IFCWALL', 'IFCWALLELEMENTEDCASE', 'IFCWALLSTANDARDCASE',
  'IFCWINDOW', 'IFCWINDOWSTANDARDCASE',
  // IfcElement > IfcDistributionElement
  'IFCDISTRIBUTIONELEMENT', 'IFCDISTRIBUTIONCONTROLELEMENT',
  'IFCDISTRIBUTIONFLOWELEMENT', 'IFCDISTRIBUTIONCHAMBERELEMENT',
  'IFCDISTRIBUTIONPORT', 'IFCDISTRIBUTIONBOARD',
  // IfcDistributionControlElement subtypes
  'IFCACTUATOR', 'IFCALARM', 'IFCCONTROLLER',
  'IFCFLOWINSTRUMENT', 'IFCPROTECTIVEDEVICETRIPPINGUNIT',
  'IFCSENSOR', 'IFCUNITARYCONTROLELEMENT',
  // IfcFlowController subtypes
  'IFCAIRTERMINALBOX', 'IFCDAMPER', 'IFCELECTRICDISTRIBUTIONBOARD',
  'IFCELECTRICTIMECONTROL', 'IFCFLOWCONTROLLER', 'IFCFLOWMETER',
  'IFCPROTECTIVEDEVICE', 'IFCSWITCHINGDEVICE', 'IFCVALVE',
  // IfcFlowFitting subtypes
  'IFCCABLECARRIERFITTING', 'IFCCABLEFITTING',
  'IFCDUCTFITTING', 'IFCFLOWFITTING', 'IFCJUNCTIONBOX', 'IFCPIPEFITTING',
  // IfcFlowMovingDevice subtypes
  'IFCCOMPRESSOR', 'IFCFAN', 'IFCFLOWMOVINGDEVICE', 'IFCPUMP',
  // IfcFlowSegment subtypes
  'IFCCABLECARRIERSEGMENT', 'IFCCABLESEGMENT', 'IFCCONVEYORSEGMENT',
  'IFCDUCTSEGMENT', 'IFCFLOWSEGMENT', 'IFCPIPESEGMENT',
  // IfcFlowStorageDevice subtypes
  'IFCELECTRICFLOWSTORAGEDEVICE', 'IFCFLOWSTORAGEDEVICE', 'IFCTANK',
  // IfcFlowTerminal subtypes
  'IFCAIRTERMINAL', 'IFCAUDIOVISUALAPPLIANCE', 'IFCCOMMUNICATIONSAPPLIANCE',
  'IFCELECTRICAPPLIANCE', 'IFCFIRESUPPRESSIONTERMINAL', 'IFCFLOWTERMINAL',
  'IFCLAMP', 'IFCLIGHTFIXTURE', 'IFCLIQUIDTERMINAL',
  'IFCMEDICALDEVICE', 'IFCMOBILETELECOMMUNICATIONSAPPLIANCE',
  'IFCOUTLET', 'IFCSANITARYTERMINAL', 'IFCSPACEHEATER',
  'IFCSTACKTERMINAL', 'IFCWASTETERMINAL',
  // IfcFlowTreatmentDevice subtypes
  'IFCDUCTSILENCER', 'IFCELECTRICFLOWTREATMENTDEVICE',
  'IFCFILTER', 'IFCFLOWTREATMENTDEVICE', 'IFCINTERCEPTOR',
  // IfcEnergyConversionDevice subtypes
  'IFCAIRTOAIRHEATRECOVERY', 'IFCBOILER', 'IFCBURNER',
  'IFCCHILLER', 'IFCCOIL', 'IFCCONDENSER',
  'IFCCOOLEDBEAM', 'IFCCOOLINGTOWER',
  'IFCELECTRICGENERATOR', 'IFCELECTRICMOTOR',
  'IFCENERGYCONVERSIONDEVICE', 'IFCENGINE',
  'IFCEVAPORATIVECOOLER', 'IFCEVAPORATOR',
  'IFCHEATEXCHANGER', 'IFCHUMIDIFIER', 'IFCMOTORCONNECTION',
  'IFCSOLARDEVICE', 'IFCTRANSFORMER', 'IFCTUBEBUNDLE',
  'IFCUNITARYEQUIPMENT',
  // IfcElement > IfcElementAssembly
  'IFCELEMENT', 'IFCELEMENTASSEMBLY',
  // IfcElement > IfcElementComponent
  'IFCELEMENTCOMPONENT', 'IFCFASTENER',
  'IFCMECHANICALFASTENER', 'IFCDISCRETEACCESSORY',
  'IFCVIBRATIONDAMPER', 'IFCVIBRATIONISOLATOR',
  'IFCIMPACTPROTECTIONDEVICE',
  // IfcElement > IfcFeatureElement
  'IFCFEATUREELEMENT', 'IFCFEATUREELEMENTADDITION', 'IFCFEATUREELEMENTSUBTRACTION',
  'IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE',
  'IFCPROJECTIONELEMENT', 'IFCSURFACEFEATURE', 'IFCVOIDINGFEATURE',
  // IfcElement > IfcFurnishingElement
  'IFCFURNISHINGELEMENT', 'IFCFURNITURE', 'IFCSYSTEMFURNITUREELEMENT',
  // IfcElement > IfcGeographicElement / IfcCivilElement
  'IFCGEOGRAPHICELEMENT', 'IFCCIVILELEMENT',
  // IfcElement > IfcTransportElement / IfcTransportationDevice / IfcVehicle
  'IFCTRANSPORTELEMENT', 'IFCTRANSPORTATIONDEVICE', 'IFCVEHICLE',
  // IfcElement > IfcReinforcingElement
  'IFCREINFORCINGELEMENT', 'IFCREINFORCINGBAR', 'IFCREINFORCINGMESH',
  'IFCTENDON', 'IFCTENDONANCHOR', 'IFCTENDONCONDUIT',
  // IfcElement > IFC4X3 additions
  'IFCBEARING', 'IFCCAISSONFOUNDATION', 'IFCCOURSE',
  'IFCEARTHWORKSCUT', 'IFCEARTHWORKSELEMENT', 'IFCEARTHWORKSFILL',
  'IFCKERB', 'IFCMOORINGDEVICE', 'IFCNAVIGATIONELEMENT',
  'IFCPAVEMENT', 'IFCRAIL', 'IFCREINFORCEDSOIL', 'IFCSIGN', 'IFCSIGNAL',
  'IFCTRACKELEMENT',
  // IFC4X3 alignment and positioning
  'IFCALIGNMENT', 'IFCALIGNMENTCANT', 'IFCALIGNMENTHORIZONTAL',
  'IFCALIGNMENTSEGMENT', 'IFCALIGNMENTVERTICAL',
  'IFCLINEARELEMENT', 'IFCLINEARPOSITIONINGELEMENT',
  'IFCPOSITIONINGELEMENT', 'IFCREFERENT',
  // IFC4X3 geotechnical
  'IFCBOREHOLE', 'IFCGEOMODEL', 'IFCGEOSLICE',
  'IFCGEOTECHNICALASSEMBLY', 'IFCGEOTECHNICALELEMENT', 'IFCGEOTECHNICALSTRATUM',
  // IfcProduct (non-element)
  'IFCANNOTATION', 'IFCGRID', 'IFCPORT', 'IFCPROXY',
  'IFCSPACE', 'IFCVIRTUALELEMENT',
  // IfcStructuralItem / IfcStructuralActivity
  'IFCSTRUCTURALACTION', 'IFCSTRUCTURALACTIVITY',
  'IFCSTRUCTURALCONNECTION', 'IFCSTRUCTURALCURVEACTION',
  'IFCSTRUCTURALCURVECONNECTION', 'IFCSTRUCTURALCURVEMEMBER',
  'IFCSTRUCTURALCURVEMEMBERVARYING', 'IFCSTRUCTURALCURVEREACTION',
  'IFCSTRUCTURALITEM', 'IFCSTRUCTURALLINEARACTION',
  'IFCSTRUCTURALMEMBER', 'IFCSTRUCTURALPLANARACTION',
  'IFCSTRUCTURALPOINTACTION', 'IFCSTRUCTURALPOINTCONNECTION',
  'IFCSTRUCTURALPOINTREACTION', 'IFCSTRUCTURALREACTION',
  'IFCSTRUCTURALSURFACEACTION', 'IFCSTRUCTURALSURFACECONNECTION',
  'IFCSTRUCTURALSURFACEMEMBER', 'IFCSTRUCTURALSURFACEMEMBERVARYING',
  'IFCSTRUCTURALSURFACEREACTION',
]);

// ---------------------------------------------------------------------------
// Byte-level #ID reference extraction
// ---------------------------------------------------------------------------

/**
 * Extract all #ID references from a raw STEP entity byte range.
 *
 * Scans the Uint8Array directly for '#' (0x23) followed by ASCII digits,
 * avoiding TextDecoder string allocation and regex overhead. Each entity
 * is visited at most once, and IDs are parsed inline from bytes.
 *
 * String-literal aware: `#N` inside a STEP `'...'` string (a Name like
 * `'detail #999'`) is TEXT, not a reference. Treating it as an edge would
 * pull unrelated entities into export closures — and, in the demesher's
 * reverse-reference prune, could tombstone a referrer-less entity that a
 * string merely mentions. The `''` escape is handled (the scan re-enters
 * string mode), so `'it''s #7'` contributes no reference either.
 *
 * ~4-15x faster than TextDecoder + regex for large closures.
 */
function extractRefsFromBytes(
  source: Uint8Array,
  byteOffset: number,
  byteLength: number,
  out: number[],
): void {
  const end = byteOffset + byteLength;
  let i = byteOffset;
  while (i < end) {
    const b = source[i];
    if (b === QUOTE) {
      // Skip the string literal: advance to the closing quote, treating the
      // '' escape as string continuation.
      i++;
      while (i < end) {
        if (source[i] === QUOTE) {
          if (i + 1 < end && source[i + 1] === QUOTE) {
            i += 2; // escaped quote, still inside the string
            continue;
          }
          i++; // real closing quote
          break;
        }
        i++;
      }
    } else if (b === HASH) {
      i++;
      // Check if followed by at least one digit
      if (i < end && source[i] >= ZERO && source[i] <= NINE) {
        let id = source[i] - ZERO;
        i++;
        while (i < end && source[i] >= ZERO && source[i] <= NINE) {
          id = id * 10 + (source[i] - ZERO);
          i++;
        }
        out.push(id);
      }
    } else {
      i++;
    }
  }
}

/**
 * Collect the `#ID` references inside one entity's byte range (fresh array
 * per call). Exported for consumers that need per-entity edges — e.g. the
 * demesher's reverse-reference prune — rather than a transitive closure.
 */
export function collectRefsInByteRange(
  source: Uint8Array,
  byteOffset: number,
  byteLength: number,
): number[] {
  const out: number[] = [];
  extractRefsFromBytes(source, byteOffset, byteLength, out);
  return out;
}

// ---------------------------------------------------------------------------
// Core closure walk
// ---------------------------------------------------------------------------

/**
 * Collect all entity IDs transitively referenced from a set of root entities.
 *
 * Starting from `rootIds`, reads each entity's raw bytes from the source buffer
 * and extracts all `#ID` references via byte-level scanning (no string
 * allocation). Recursively follows references to build a complete closure
 * that guarantees referential integrity.
 *
 * @param rootIds - Seed entity IDs to start the walk from
 * @param source - The original STEP file source buffer
 * @param entityIndex - Map of expressId → byte position in source
 * @param excludeIds - Entity IDs to NEVER follow during the walk.
 *
 * Performance: O(total bytes of included entities). Each entity visited once.
 * Uses byte-level scanning — no TextDecoder, no regex, no string allocation.
 */
export function collectReferencedEntityIds(
  rootIds: Set<number>,
  source: Uint8Array,
  entityIndex: { get(id: number): { byteOffset: number; byteLength: number } | undefined; has(id: number): boolean },
  excludeIds?: Set<number>,
): Set<number> {
  const visited = new Set<number>();
  const queue: number[] = [];

  // Seed the queue with roots that exist in the entity index
  for (const id of rootIds) {
    if (entityIndex.has(id) && !visited.has(id)) {
      visited.add(id);
      queue.push(id);
    }
  }

  // Reusable buffer for extracted refs (avoids per-entity allocation)
  const refs: number[] = [];

  while (queue.length > 0) {
    const entityId = queue.pop()!;
    const ref = entityIndex.get(entityId);
    if (!ref) continue;

    // Extract #ID references directly from bytes
    refs.length = 0;
    extractRefsFromBytes(source, ref.byteOffset, ref.byteLength, refs);

    for (let i = 0; i < refs.length; i++) {
      const referencedId = refs[i];
      if (!visited.has(referencedId) && entityIndex.has(referencedId)) {
        if (excludeIds && excludeIds.has(referencedId)) {
          continue;
        }
        visited.add(referencedId);
        queue.push(referencedId);
      }
    }
  }

  return visited;
}

// ---------------------------------------------------------------------------
// Visibility classification
// ---------------------------------------------------------------------------

/**
 * Compute the root entity set and hidden product IDs for a visible-only export.
 *
 * Returns:
 * - `roots`: Entity IDs that form the seed set for the reference closure.
 *   Includes infrastructure, spatial structure, relationship entities, and
 *   visible product entities.
 * - `hiddenProductIds`: Product entity IDs that are hidden/not isolated.
 *   These should be passed as `excludeIds` to `collectReferencedEntityIds`
 *   to prevent the closure from walking into hidden products' geometry.
 *
 * Also propagates hidden status from building elements to their openings
 * via IfcRelVoidsElement, so orphaned openings are excluded.
 */
export function getVisibleEntityIds(
  dataStore: IfcDataStore,
  hiddenIds: Set<number>,
  isolatedIds: Set<number> | null,
): { roots: Set<number>; hiddenProductIds: Set<number> } {
  const roots = new Set<number>();
  const hiddenProductIds = new Set<number>();

  for (const [expressId, entityRef] of dataStore.entityIndex.byId) {
    const typeUpper = entityRef.type.toUpperCase();

    // Always include infrastructure entities (units, contexts, owner history)
    if (INFRASTRUCTURE_TYPES.has(typeUpper)) {
      roots.add(expressId);
      continue;
    }

    // Always include spatial structure (project, site, building, storey, facility)
    if (SPATIAL_STRUCTURE_TYPES.has(typeUpper)) {
      roots.add(expressId);
      continue;
    }

    // Always include relationship entities as roots.
    // Relationships reference products (not vice versa), so they must be roots
    // for properties, materials, and type definitions to be reachable.
    if (typeUpper.startsWith('IFCREL')) {
      roots.add(expressId);
      continue;
    }

    // For product/element entities: check visibility
    if (PRODUCT_TYPES.has(typeUpper)) {
      const isHidden = hiddenIds.has(expressId);
      const isNotIsolated = isolatedIds !== null && !isolatedIds.has(expressId);

      if (isHidden || isNotIsolated) {
        hiddenProductIds.add(expressId);
      } else {
        roots.add(expressId);
      }
      continue;
    }

    // Fallback: if the entity ID is explicitly hidden by the viewer, block it
    // even if its type isn't in PRODUCT_TYPES (catches future schema additions)
    if (hiddenIds.has(expressId)) {
      hiddenProductIds.add(expressId);
      continue;
    }

    // Fallback: if isolation is active and this entity IS isolated, it must be
    // a product the user wants to see — make it a root
    if (isolatedIds !== null && isolatedIds.has(expressId)) {
      roots.add(expressId);
      continue;
    }

    // All other entity types (geometry, properties, materials, type objects, etc.)
    // are NOT roots. They will only be included if transitively referenced by
    // a root entity during the closure walk. This ensures hidden products'
    // exclusively-referenced geometry is excluded.
  }

  // Propagate hidden status to openings whose parent element is hidden.
  // IfcRelVoidsElement(_, _, _, _, #RelatingElement, #RelatedOpening) — if
  // the relating element is hidden, the opening must be excluded too.
  propagateOpeningExclusions(dataStore, roots, hiddenProductIds);

  return { roots, hiddenProductIds };
}

/**
 * Propagate hidden status from building elements to their openings.
 *
 * Uses byte-level scanning on IfcRelVoidsElement entities (via byType index)
 * to extract the last two #ID refs (RelatingBuildingElement, RelatedOpening).
 */
function propagateOpeningExclusions(
  dataStore: IfcDataStore,
  roots: Set<number>,
  hiddenProductIds: Set<number>,
): void {
  const source = dataStore.source;
  if (!source) return;

  const relVoidsIds = dataStore.entityIndex.byType.get('IFCRELVOIDSELEMENT') ?? [];
  if (relVoidsIds.length === 0) return;

  const refs: number[] = [];

  for (const relId of relVoidsIds) {
    const entityRef = dataStore.entityIndex.byId.get(relId);
    if (!entityRef) continue;

    // Find the opening paren to skip the leading #ID=TYPE(
    let parenPos = entityRef.byteOffset;
    const end = entityRef.byteOffset + entityRef.byteLength;
    while (parenPos < end && source[parenPos] !== 0x28 /* '(' */) parenPos++;
    if (parenPos >= end) continue;

    refs.length = 0;
    extractRefsFromBytes(source, parenPos, end - parenPos, refs);

    if (refs.length < 2) continue;
    const relatingElementId = refs[refs.length - 2];
    const relatedOpeningId = refs[refs.length - 1];

    if (hiddenProductIds.has(relatingElementId)) {
      hiddenProductIds.add(relatedOpeningId);
      roots.delete(relId);
      roots.delete(relatedOpeningId);
    }
  }
}

// ---------------------------------------------------------------------------
// Style entity collection (reverse pass)
// ---------------------------------------------------------------------------

/**
 * Collect style entities (IFCSTYLEDITEM, etc.) that reference geometry already
 * in the closure, then transitively follow their style references.
 *
 * In IFC STEP, IFCSTYLEDITEM references a geometry RepresentationItem, but
 * nothing references the StyledItem back. So the forward closure walk misses
 * them entirely. This function does a reverse pass using the byType index:
 * for each styled item, check if any referenced ID is in the closure. If yes,
 * add the styled item and walk its style chain into the closure.
 *
 * Uses byType for O(styledItems) instead of O(allEntities), and byte-level
 * scanning for #ID extraction.
 *
 * Must be called AFTER collectReferencedEntityIds so the closure is complete.
 *
 * @param closure - The existing closure set (mutated in place)
 * @param source - The original STEP file source buffer
 * @param entityIndex - Full entity index with type info and byType lookup
 */
export function collectStyleEntities(
  closure: Set<number>,
  source: Uint8Array,
  entityIndex: {
    byId: { get(expressId: number): { type: string; byteOffset: number; byteLength: number } | undefined; has(expressId: number): boolean };
    byType: Map<string, number[]>;
  },
): void {
  const queue: number[] = [];
  const refs: number[] = [];

  // Use byType index for direct lookup — O(styledItems) not O(allEntities)
  const styledItemIds = entityIndex.byType.get('IFCSTYLEDITEM') ?? [];
  const styledRepIds = entityIndex.byType.get('IFCSTYLEDREPRESENTATION') ?? [];

  for (const ids of [styledItemIds, styledRepIds]) {
    for (const expressId of ids) {
      if (closure.has(expressId)) continue;

      const entityRef = entityIndex.byId.get(expressId);
      if (!entityRef) continue;

      // Check if any referenced ID is in the closure
      refs.length = 0;
      extractRefsFromBytes(source, entityRef.byteOffset, entityRef.byteLength, refs);

      let referencesClosureEntity = false;
      for (let i = 0; i < refs.length; i++) {
        if (closure.has(refs[i])) {
          referencesClosureEntity = true;
          break;
        }
      }

      if (referencesClosureEntity) {
        closure.add(expressId);
        queue.push(expressId);
      }
    }
  }

  // Walk forward from newly added style entities to pull in their style chain
  // (IfcPresentationStyleAssignment → IfcSurfaceStyle → IfcSurfaceStyleRendering → IfcColourRgb)
  while (queue.length > 0) {
    const entityId = queue.pop()!;
    const ref = entityIndex.byId.get(entityId);
    if (!ref) continue;

    refs.length = 0;
    extractRefsFromBytes(source, ref.byteOffset, ref.byteLength, refs);

    for (let i = 0; i < refs.length; i++) {
      const referencedId = refs[i];
      if (!closure.has(referencedId) && entityIndex.byId.has(referencedId)) {
        closure.add(referencedId);
        queue.push(referencedId);
      }
    }
  }
}
