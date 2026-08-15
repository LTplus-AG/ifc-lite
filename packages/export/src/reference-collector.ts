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

import type { IfcDataStore, IfcSourceBytes } from '@ifc-lite/parser';
import { asSourceBytes } from '@ifc-lite/parser';
import type { EffectiveEntityIndex } from './effective-index.js';
import { splitTopLevelArgs } from './step-argument-parser.js';

/**
 * UTF-8 decode of `[start, end)` of the source. Mirrors `step-exporter.ts` /
 * `merged-exporter.ts`'s local `decodeRange` (SAB-safe via the accessor);
 * duplicated rather than shared because this is the only place in the file
 * that needs text instead of raw bytes, and it is only reached for `IFCREL*`
 * entities under `visibleOnly` (see `collectReferencedEntityIds`).
 */
function decodeRange(src: IfcSourceBytes, start: number, end: number): string {
  return src.decodeUtf8(start, end);
}

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
  source: Uint8Array | IfcSourceBytes,
  byteOffset: number,
  byteLength: number,
): number[] {
  const out: number[] = [];
  const span = asSourceBytes(source).slice(byteOffset, byteOffset + byteLength);
  extractRefsFromBytes(span, 0, span.length, out);
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
 * @param entityIndex - Map of expressId → byte position in source. An index
 *   that also answers `refsOf` (see `EffectiveEntityIndex`) contributes
 *   overlay-created records, whose references live in an authored attribute
 *   list rather than in the source buffer — without that hook the walk stops
 *   dead at a created entity and everything reachable only through it is
 *   silently dropped from the export (#2012).
 * @param excludeIds - Entity IDs to NEVER follow during the walk. Also gates
 *   whether an `IFCREL*` entity may act as a BRIDGE into what it references:
 *   when every id it names would be filtered out by
 *   {@link filterHiddenRefsFromRelationshipLine} (same predicate — the
 *   relationship's own line would be withheld entirely), the walk does not
 *   follow ANY of its references. Without this, a relationship whose sole
 *   subject is excluded still pulled its pset/material/type/classification
 *   target into the closure — those are never themselves in `excludeIds` (not
 *   products) — so the target shipped as an orphan line nothing in the output
 *   names (#2548).
 * @param isRefExcluded - The caller's OWN "is this id excluded from what a
 *   relationship names" predicate — the exact one it will use to filter that
 *   relationship's OUTPUT line (`isExcludedFromRelationshipRefs` in
 *   `step-exporter.ts`). When supplied, the bridge decision above uses THIS
 *   predicate instead of inventing `excludeIds.has(id) || !entityIndex.has(id)`
 *   as a proxy for it. The proxy and a caller's real predicate can disagree on
 *   an id that never existed in the file at all (not hidden, not deleted —
 *   just absent, e.g. a pre-existing dangling ref in a truncated source): the
 *   proxy treats "not in the index" as excluded, blocking the bridge, while a
 *   caller whose predicate only excludes a hidden PRODUCT or a TOMBSTONED id
 *   does not, and still emits the relationship's line naming it. Left to
 *   disagree, that combination drops a VISIBLE sibling's pset from the
 *   closure while the unfiltered output line still names it — a dangling ref
 *   the emission pass did not intend to create. Callers with no caller-side
 *   emission predicate to share (`demesh-prune.ts`, `merged-exporter.ts`,
 *   whose own `IFCREL*` output-line filter already reduces to the same
 *   `!entityIndex.has` proxy) omit this and keep the previous behaviour.
 *
 * Performance: O(total bytes of included entities). Each entity visited once.
 * Uses byte-level scanning — no TextDecoder, no regex, no string allocation —
 * except for a SOURCE-BACKED `IFCREL*` entity when `excludeIds` was passed at
 * all, which decodes and parses its line once, for BOTH the bridge decision
 * and the refs enqueued (the same parsed groups feed both — see
 * `sourceRelGroups` below), rather than once per purpose.
 */
export function collectReferencedEntityIds(
  rootIds: Set<number>,
  source: Uint8Array | IfcSourceBytes,
  entityIndex: {
    get(id: number): { byteOffset: number; byteLength: number; type?: string } | undefined;
    has(id: number): boolean;
    refsOf?(id: number): readonly number[] | undefined;
    refGroupsOf?(
      id: number,
      sourceGroups?: ReadonlyArray<number | readonly number[] | undefined>,
    ): ReadonlyArray<number | readonly number[]> | undefined;
    effectiveType?(id: number, recordType: string): string;
    hasSourceMutation?(id: number): boolean;
  },
  excludeIds?: Set<number>,
  isRefExcluded?: (id: number) => boolean,
): Set<number> {
  const src = asSourceBytes(source);
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

  // The bridge decision below needs "is this id excluded from what a
  // relationship names" — ideally the CALLER's own answer to that question
  // (`isRefExcluded`), since that is the exact predicate it will also use to
  // filter the relationship's OUTPUT line. When a caller has none to share,
  // fall back to `excludeIds.has(id) || !entityIndex.has(id)` — the same
  // proxy as before, which also correctly covers a TOMBSTONED id (a deleted
  // entity is absent from the effective index too, so `!entityIndex.has`
  // catches it), but additionally — and wrongly, for a caller whose own
  // predicate would not — treats an id that never existed in the file at all
  // as excluded. See the `isRefExcluded` param doc for why that divergence
  // matters (#2548 follow-up).
  const isBridgeTargetExcluded = excludeIds
    ? (isRefExcluded ?? ((id: number): boolean => excludeIds.has(id) || !entityIndex.has(id)))
    : null;

  while (queue.length > 0) {
    const entityId = queue.pop()!;
    const ref = entityIndex.get(entityId);
    if (!ref) continue;

    // Overlay-created records have no bytes to scan; their references come off
    // the authored attribute list instead.
    const authored = entityIndex.refsOf?.(entityId);
    refs.length = 0;

    // ONE decision, shared by both ref sources: an `IFCREL*` entity only
    // bridges into what it names when its own line would survive
    // `relationshipRefsSurviveExclusion` (the same list-vs-bare predicate
    // `filterHiddenRefsFromRelationshipLine` applies to a relationship's
    // OUTPUT line). If every id in a SET/LIST attribute is excluded, or any
    // single-valued attribute's id is excluded, that function would withhold
    // the line entirely — so the walk must not follow any of its refs either,
    // or a target unreachable by anything else in the file (a pset, material,
    // type, classification) still ends up in the closure (#2548).
    //
    // This runs identically for a source-backed record (groups parsed from
    // the decoded STEP line) and an overlay-created one (groups read off the
    // authored attribute list via `refGroupsOf`) — a single call site, not one
    // check per ref source, so the two paths cannot silently diverge again
    // the way the authored path originally missed this check entirely.
    // Gated on `excludeIds !== undefined` — its PRESENCE, not its size —
    // because a visibleOnly export with nothing explicitly hidden but a
    // deletion in effect passes an EMPTY `hiddenProductIds` Set; `size > 0`
    // would skip this and miss the deletion case. Callers with no filtering at
    // all (`demesh-prune.ts`) pass `excludeIds` as `undefined`, not an empty
    // Set, so they still take the fast path.
    //
    // Classified by the EFFECTIVE type (`entityIndex.effectiveType`) when the
    // index can answer it, not the authored/source `ref.type`: a retype can
    // move a record across the `IFCREL*` boundary in either direction, and
    // emission (`step-exporter.ts`'s `effectiveRelType` check ahead of its own
    // `filterHiddenRefsFromRelationshipLine` call) already classifies by the
    // effective class. A closure walk that classified by the stale authored
    // type could block-or-bridge on a class the file will not actually emit
    // for this id. Falls back to the authored `ref.type` when the index has no
    // `effectiveType` (a test double, or a caller with no overlay at all,
    // where authored and effective always agree).
    const bridgeType = (
      entityIndex.effectiveType && ref.type !== undefined
        ? entityIndex.effectiveType(entityId, ref.type)
        : ref.type
    );

    // Mutation-aware groups for a SOURCE-BACKED `IFCREL*` entity — computed
    // ONCE below and consumed by BOTH the bridge decision and the refs
    // actually enqueued further down, so the two cannot answer differently.
    // Round 4 fed this same mutation-aware answer only to the bridge
    // decision and left the enqueue step re-scanning the entity's ORIGINAL
    // bytes, so an override that survived the gate (the relationship keeps
    // bridging) was then invisible to what got walked: the emitted line
    // named the retargeted id, but the closure never queued it, shipping a
    // dangling ref (#2637 follow-up). Left undefined — and the walk falls
    // back to the raw byte scan, unchanged — whenever there is no bridge
    // decision to share it with (a non-relationship entity, or a caller with
    // no `excludeIds` at all, e.g. `demesh-prune.ts`).
    let sourceRelGroups: ReadonlyArray<number | readonly number[]> | undefined;

    if (
      isBridgeTargetExcluded !== null
      && bridgeType !== undefined && bridgeType.toUpperCase().startsWith('IFCREL')
    ) {
      const groups = authored
        ? (entityIndex.refGroupsOf?.(entityId)
            // No structured answer available (a test double or caller that
            // only implements `refsOf`) — fall back to treating every
            // authored ref as its own bare group. Strictly MORE conservative
            // than the real grouping (a list with a surviving member would
            // wrongly block bridging too), never less: it can only refuse to
            // bridge, never leak, when the finer answer is unavailable.
            ?? authored)
        // Source-backed: parse the RAW line into groups first (the only
        // thing there is to parse for an id with no authored payload), then
        // give the entity index a chance to splice in a queued positional or
        // named-attribute override — a mutation retargeting THIS relationship's
        // own reference (e.g. `RelatedObjects` moved off a hidden product onto
        // a visible one) changes what the file will actually say, and the raw
        // text alone cannot know that (#2637 follow-up: CodeRabbit found the
        // emitted line and this bridge check could disagree on exactly that
        // case). `refGroupsOf` returns undefined when nothing overrides
        // anything for this id, so the parsed-from-text answer stands. Stored
        // in `sourceRelGroups` (not just a local) so the enqueue step below
        // reuses this SAME answer instead of re-deriving it from the stale
        // original bytes.
        : (sourceRelGroups = relationshipRefGroupsFromSourceLine(
            entityIndex,
            entityId,
            decodeRange(src, ref.byteOffset, ref.byteOffset + ref.byteLength),
          ));
      if (!relationshipRefsSurviveExclusion(groups, isBridgeTargetExcluded)) {
        continue;
      }
    }

    if (authored) {
      refs.push(...authored);
    } else if (sourceRelGroups) {
      // The exact groups the bridge decision above just used to let this
      // entity through — walk THOSE, not a fresh scan of the original bytes,
      // so a queued override that retargeted one of this relationship's own
      // references is reachable by the closure the same way it will be named
      // in the emitted line.
      for (const group of sourceRelGroups) {
        if (Array.isArray(group)) refs.push(...group);
        else refs.push(group as number);
      }
    } else if (entityIndex.hasSourceMutation?.(entityId)) {
      // Same gap as `sourceRelGroups` above, one level more general: this
      // entity did not take the `IFCREL*` bridge path above at all (an
      // ordinary product, or a caller with no `excludeIds` to bridge on), but
      // it DOES carry a queued positional/named-attribute mutation, and a
      // mutation can retarget a reference onto an id the original bytes never
      // named — invisible to a plain byte scan, but still what emission will
      // write (#2637 general follow-up: the round-5 fix only closed this for
      // `IFCREL*`; any other source-backed entity's retargeted reference
      // dangled the same way, discovered via a retype-out-of-`IFCREL*` fused
      // with a same-record retarget, but reproducing with no retype involved
      // at all). Gated on the cheap `hasSourceMutation` check so an entity
      // with nothing queued — the overwhelming majority — still takes the
      // plain byte scan below with no decode/parse cost.
      const generalGroups = relationshipRefGroupsFromSourceLine(
        entityIndex,
        entityId,
        decodeRange(src, ref.byteOffset, ref.byteOffset + ref.byteLength),
      );
      for (const group of generalGroups) {
        if (Array.isArray(group)) refs.push(...group);
        else refs.push(group as number);
      }
    } else {
      // Hand the byte scanner an already-narrowed record. `slice` is a
      // `subarray` on a contiguous source, so this is the same zero-copy read.
      const span = src.slice(ref.byteOffset, ref.byteOffset + ref.byteLength);
      extractRefsFromBytes(span, 0, span.length, refs);
    }

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

/**
 * Rewrite (or withhold) a relationship's OWN line so it never names an
 * excluded entity — the id, not just the byte range, has to disappear.
 *
 * `getVisibleEntityIds` keeps a hidden PRODUCT's own defining line out of the
 * export, and `collectReferencedEntityIds` refuses to WALK INTO one (that is
 * what `hiddenIds` is passed as `excludeIds` for). Neither touches the
 * relationship that named it: `IFCREL*` is an unconditional root — relationships
 * point at products, never the reverse, so they must stay reachable for psets,
 * materials and types to survive the closure — and a root's own bytes are
 * copied to the output VERBATIM. So a `IfcRelContainedInSpatialStructure`
 * naming both a kept and a hidden wall keeps naming the hidden one; the file
 * that ships has a `#N` with no `#N=` line, which strict readers reject and
 * lenient ones silently mis-place (confirmed on #2398, root-caused to this
 * exact gap).
 *
 * Fixed here rather than by teaching the closure to special-case every
 * `IFCREL*` subtype: the two shapes below are SYNTACTIC, not semantic, so one
 * function covers every relationship class without a table of which attribute
 * index means what per type.
 *
 *  - A `#N` inside a NESTED parenthesised list (`RelatedObjects`,
 *    `RelatedElements`, …): drop just that member. If every member of the
 *    list was hidden, the list is empty — a SET attribute of a real IFC schema
 *    is never empty, so an empty list is not "no forward reference", it is a
 *    second, different kind of invalid file. Withhold the whole line instead.
 *  - A bare top-level `#N` (`RelatingSpace`, `RelatedOpeningElement`, …): a
 *    single-valued STEP attribute has no spelling for "omitted but this one
 *    was mandatory", so a hidden reference here withholds the whole line —
 *    the same choice `propagateOpeningExclusions` already makes for the one
 *    case (`IfcRelVoidsElement`, relating side hidden) it special-cased before
 *    this function existed.
 *
 * Returns the line unchanged when it names nothing excluded, a rewritten line
 * when a list member was dropped, or `null` to mean "do not emit this
 * relationship at all". A line this cannot parse as a single `#N=TYPE(...);`
 * record is returned unchanged — the source-iteration pass's own byte-range
 * and mutation passes are what validate that shape; this function only ever
 * narrows what a well-formed one contains.
 *
 * `isExcluded` is a predicate rather than a fixed `Set` because "excluded"
 * has two independent sources that a caller may need to combine: a
 * `visibleOnly` hidden PRODUCT id (`hiddenProductIds`, a plain membership
 * test) and a TOMBSTONED id (`effective.isDeleted`, answered by the overlay
 * for every id, not just a precomputed set) — the DELETION-path instance of
 * this exact dangling-ref shape (#2398): a relationship that still names an
 * entity the session deleted ships the same `#N` with no `#N=` line, on a
 * path with no `visibleOnly` involved at all.
 */
export function filterHiddenRefsFromRelationshipLine(
  line: string,
  isExcluded: (id: number) => boolean,
): string | null {
  const match = line.match(/^(#\d+\s*=\s*\w+\()([\s\S]*)(\)\s*;)\s*$/);
  if (!match) return line;
  const [, prefix, argsText, suffix] = match;
  const attrs = splitTopLevelArgs(argsText);

  let changed = false;
  const nextAttrs: string[] = [];
  for (const attr of attrs) {
    if (attr.length >= 2 && attr.charCodeAt(0) === 0x28 /* '(' */ && attr.charCodeAt(attr.length - 1) === 0x29 /* ')' */) {
      const inner = attr.slice(1, -1);
      const items = inner.trim() === '' ? [] : splitTopLevelArgs(inner);
      const survivors = items.filter((item) => {
        const refMatch = item.match(/^#(\d+)$/);
        return !(refMatch && isExcluded(Number(refMatch[1])));
      });
      if (survivors.length !== items.length) {
        if (survivors.length === 0) return null;
        changed = true;
        nextAttrs.push(`(${survivors.join(',')})`);
        continue;
      }
      nextAttrs.push(attr);
      continue;
    }

    const refMatch = attr.match(/^#(\d+)$/);
    if (refMatch && isExcluded(Number(refMatch[1]))) return null;
    nextAttrs.push(attr);
  }

  if (!changed) return line;
  return `${prefix}${nextAttrs.join(',')}${suffix}`;
}

/**
 * The "does this relationship's own line survive at all" half of
 * {@link filterHiddenRefsFromRelationshipLine}, extracted as a standalone
 * predicate over an already-grouped ref list rather than raw STEP text — so
 * `collectReferencedEntityIds` can apply the exact same bridging decision to
 * an overlay-created `IFCREL*` entity (whose references never had STEP text
 * to begin with) as it does to a source-backed one. One function, called from
 * both branches of the closure walk, is what makes the two paths
 * structurally unable to diverge again — see the #2548 authored-path gap this
 * closes.
 *
 * Each element of `refGroups` is one authored attribute's contribution:
 *
 *  - an ARRAY is a SET/LIST attribute (`RelatedObjects`, …) — it blocks
 *    bridging only when it names at least one id and EVERY one is excluded
 *    (an empty list, or one with a survivor, does not).
 *  - a bare NUMBER is a single-valued attribute (`RelatingType`, …) — it
 *    blocks bridging the instant that one id is excluded, regardless of any
 *    other group, mirroring "a single-valued STEP attribute has no spelling
 *    for omitted" from `filterHiddenRefsFromRelationshipLine`'s own doc.
 */
export function relationshipRefsSurviveExclusion(
  refGroups: ReadonlyArray<number | readonly number[]>,
  isExcluded: (id: number) => boolean,
): boolean {
  for (const group of refGroups) {
    if (Array.isArray(group)) {
      if (group.length > 0 && group.every(isExcluded)) return false;
    } else if (isExcluded(group as number)) {
      return false;
    }
  }
  return true;
}

/**
 * Parse a source-backed relationship's decoded STEP line into the same
 * grouped shape {@link relationshipRefsSurviveExclusion} takes, POSITION-
 * ALIGNED with the line's top-level STEP arguments (one array entry per
 * argument, `undefined` where that argument names no reference) — the form
 * {@link relationshipRefGroupsFromSourceLine} needs to splice a positional or
 * named-attribute override into the right slot.
 *
 * Built from the exact same primitives (`splitTopLevelArgs`, the `#(\d+)`
 * ref pattern) `filterHiddenRefsFromRelationshipLine` uses, so the two
 * extraction routes (this one from text, `refGroupsOf` from an authored
 * attribute list) feed the SAME decision function identically. A line that
 * does not parse as a single `#N=TYPE(...);` record yields no groups —
 * nothing to exclude on, so the relationship survives, matching that
 * function's own "return line unchanged" behavior for the same input shape.
 *
 * A parenthesised list holding a NON-reference item (an inline typed value
 * alongside, or instead of, `#N` members) yields `undefined` for that slot
 * rather than a groups-worth of only the ref members: such an item always
 * survives `filterHiddenRefsFromRelationshipLine`'s own per-item filter (it
 * only ever drops an `#N` item), so a list containing one can never be the
 * reason that function withholds the whole line — treating the ref-only
 * subset as a blocking group here would let this predicate refuse a bridge
 * `filterHiddenRefsFromRelationshipLine` does not (CodeRabbit finding on
 * #2637: this used to collapse a mixed list to "every remaining id
 * excluded" and block on it).
 */
function extractRelationshipRefGroupsIndexed(line: string): Array<number | number[] | undefined> {
  const match = line.match(/^(#\d+\s*=\s*\w+\()([\s\S]*)(\)\s*;)\s*$/);
  if (!match) return [];
  const attrs = splitTopLevelArgs(match[2]);
  const groups: Array<number | number[] | undefined> = [];
  for (const attr of attrs) {
    if (attr.length >= 2 && attr.charCodeAt(0) === 0x28 /* '(' */ && attr.charCodeAt(attr.length - 1) === 0x29 /* ')' */) {
      const inner = attr.slice(1, -1);
      const items = inner.trim() === '' ? [] : splitTopLevelArgs(inner);
      const ids: number[] = [];
      let hasNonRefItem = false;
      for (const item of items) {
        const refMatch = item.match(/^#(\d+)$/);
        if (refMatch) ids.push(Number(refMatch[1]));
        else hasNonRefItem = true;
      }
      groups.push(hasNonRefItem ? undefined : ids);
      continue;
    }
    const refMatch = attr.match(/^#(\d+)$/);
    groups.push(refMatch ? Number(refMatch[1]) : undefined);
  }
  return groups;
}

/**
 * Parse `line` into the position-aligned shape, then — when `entityIndex` can
 * answer for `entityId` — let it splice in a queued positional or
 * named-attribute override before flattening. Falls back to the plain
 * parsed-from-text groups when the index has no `refGroupsOf`, or answers
 * undefined for this id (the common case: most entities carry no mutation at
 * all, so this stays a cheap parse plus a couple of map lookups, not extra
 * allocation).
 *
 * Used two ways in `collectReferencedEntityIds`: for the `IFCREL*` bridge
 * decision — {@link relationshipRefsSurviveExclusion} checks the groups this
 * returns — and, more generally, for ANY source-backed entity's own enqueued
 * refs once `hasSourceMutation` says a mutation is queued for it, `IFCREL*`
 * or not. Despite the name, nothing here is relationship-specific: it is
 * purely syntactic `#N=TYPE(...)` positional parsing, the same reason
 * {@link filterHiddenRefsFromRelationshipLine} needs no per-subtype table.
 */
function relationshipRefGroupsFromSourceLine(
  entityIndex: {
    refGroupsOf?(
      id: number,
      sourceGroups?: ReadonlyArray<number | readonly number[] | undefined>,
    ): ReadonlyArray<number | readonly number[]> | undefined;
  },
  entityId: number,
  line: string,
): ReadonlyArray<number | readonly number[]> {
  const indexed = extractRelationshipRefGroupsIndexed(line);
  const effective = entityIndex.refGroupsOf?.(entityId, indexed);
  if (effective) return effective;
  const groups: Array<number | number[]> = [];
  for (const group of indexed) if (group !== undefined) groups.push(group);
  return groups;
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
 *
 * Pass `index` (an `EffectiveEntityIndex`) to classify the model the session
 * will actually save: overlay-created entities become roots by the same type
 * rules as parsed ones, tombstoned entities are gone, and a retyped entity is
 * classified by its NEW class. Without it, classification runs over the source
 * buffer alone and a created wall can never be a root — it is not in the index,
 * and nothing in the source references it, so `visibleOnly` dropped it from the
 * file with no error and no warning (#2012).
 */
export function getVisibleEntityIds(
  dataStore: IfcDataStore,
  hiddenIds: Set<number>,
  isolatedIds: Set<number> | null,
  index?: EffectiveEntityIndex,
): { roots: Set<number>; hiddenProductIds: Set<number> } {
  const roots = new Set<number>();
  const hiddenProductIds = new Set<number>();

  const entries: Iterable<[number, { type: string }]> = index ?? dataStore.entityIndex.byId;
  for (const [expressId, entityRef] of entries) {
    const typeUpper = index
      ? index.effectiveType(expressId, entityRef.type)
      : entityRef.type.toUpperCase();

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
  propagateOpeningExclusions(dataStore, roots, hiddenProductIds, index);

  return { roots, hiddenProductIds };
}

/**
 * Propagate hidden status from building elements to their openings.
 *
 * Uses byte-level scanning on IfcRelVoidsElement entities (via byType index)
 * to extract the last two #ID refs (RelatingBuildingElement, RelatedOpening).
 *
 * An overlay-created relation cannot use that last-two-of-the-bytes trick
 * (there are no bytes), nor can it safely use the last two of `refsOf` --
 * `refsOf` is a UNION of the creation payload and every queued mutation ref
 * (see its own doc), so once the relation is edited after creation a
 * mutation ref lands after BOTH creation-payload refs, and "last two" no
 * longer lines up with (RelatingBuildingElement, RelatedOpeningElement)
 * (#2347). For those, resolve each end BY ATTRIBUTE NAME via
 * `effectiveAttributeRef`, which reads the current override for that named
 * slot instead of a positional guess out of the union.
 */
function propagateOpeningExclusions(
  dataStore: IfcDataStore,
  roots: Set<number>,
  hiddenProductIds: Set<number>,
  index?: EffectiveEntityIndex,
): void {
  const source = dataStore.source;
  // Deliberately NOT an early return on an empty source. The overlay-authored
  // branch below reads no bytes at all -- it serves refs straight from the
  // creation payload -- so bailing here would drop opening-exclusion
  // propagation for relations that exist only in an overlay. The guard this
  // replaced (`if (!source) return`) never fired in practice, because even a
  // zero-length Uint8Array is truthy; keeping the byte check scoped to the byte
  // scan is what preserves that behaviour. See #2339.

  const relVoidsIds = (index?.byType ?? dataStore.entityIndex.byType).get('IFCRELVOIDSELEMENT') ?? [];
  if (relVoidsIds.length === 0) return;

  const refs: number[] = [];

  for (const relId of relVoidsIds) {
    const entityRef = index ? index.get(relId) : dataStore.entityIndex.byId.get(relId);
    if (!entityRef) continue;

    let relatingElementId: number | undefined;
    let relatedOpeningId: number | undefined;

    const authored = index?.refsOf(relId);
    if (authored && index && typeof index.effectiveAttributeRef === 'function') {
      relatingElementId = index.effectiveAttributeRef(relId, 'RelatingBuildingElement');
      relatedOpeningId = index.effectiveAttributeRef(relId, 'RelatedOpeningElement');
    } else if (authored) {
      // Fallback for an index that only answers `refsOf` (e.g. a
      // create-only test double). Exact as long as the relation was never
      // edited after creation -- the same last-two rule the byte scan uses.
      refs.length = 0;
      refs.push(...authored);
      if (refs.length >= 2) {
        relatingElementId = refs[refs.length - 2];
        relatedOpeningId = refs[refs.length - 1];
      }
    } else {
      // Only the byte scan needs bytes.
      if (source.byteLength === 0) continue;
      // Hand the byte scan an already-narrowed record, as the closure walk
      // does. `slice` is a `subarray` on a contiguous source, so this is the
      // same zero-copy read, and the scan below indexes the span from 0.
      const span = source.slice(entityRef.byteOffset, entityRef.byteOffset + entityRef.byteLength);
      // Find the opening paren to skip the leading #ID=TYPE(
      const end = span.length;
      let parenPos = 0;
      while (parenPos < end && span[parenPos] !== 0x28 /* '(' */) parenPos++;
      if (parenPos >= end) continue;
      refs.length = 0;
      extractRefsFromBytes(span, parenPos, end - parenPos, refs);
      if (refs.length >= 2) {
        relatingElementId = refs[refs.length - 2];
        relatedOpeningId = refs[refs.length - 1];
      }
    }

    if (relatingElementId === undefined || relatedOpeningId === undefined) continue;

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
  source: Uint8Array | IfcSourceBytes,
  entityIndex: {
    byId: {
      get(expressId: number): { type: string; byteOffset: number; byteLength: number } | undefined;
      has(expressId: number): boolean;
      refsOf?(expressId: number): readonly number[] | undefined;
    };
    byType: Map<string, number[]>;
  },
): void {
  const src = asSourceBytes(source);
  const queue: number[] = [];
  const refs: number[] = [];
  const refsInto = (expressId: number, ref: { byteOffset: number; byteLength: number }): void => {
    refs.length = 0;
    const authored = entityIndex.byId.refsOf?.(expressId);
    if (authored) refs.push(...authored);
    else {
      const span = src.slice(ref.byteOffset, ref.byteOffset + ref.byteLength);
      extractRefsFromBytes(span, 0, span.length, refs);
    }
  };

  // Use byType index for direct lookup — O(styledItems) not O(allEntities)
  const styledItemIds = entityIndex.byType.get('IFCSTYLEDITEM') ?? [];
  const styledRepIds = entityIndex.byType.get('IFCSTYLEDREPRESENTATION') ?? [];

  for (const ids of [styledItemIds, styledRepIds]) {
    for (const expressId of ids) {
      if (closure.has(expressId)) continue;

      const entityRef = entityIndex.byId.get(expressId);
      if (!entityRef) continue;

      // Check if any referenced ID is in the closure
      refsInto(expressId, entityRef);

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

    refsInto(entityId, ref);

    for (let i = 0; i < refs.length; i++) {
      const referencedId = refs[i];
      if (!closure.has(referencedId) && entityIndex.byId.has(referencedId)) {
        closure.add(referencedId);
        queue.push(referencedId);
      }
    }
  }
}
