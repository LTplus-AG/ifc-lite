/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The public vocabulary of the "anonymized isolated export" feature (#2934):
 * what a caller passes to `collectRelatedEntities` / `exportAnonymizedSubset`
 * and what it gets back. Declarations only, split out the same way
 * `step-export-types.ts` is split from `step-exporter.ts` — so the two
 * orchestrators (`related-entities.ts`, `anonymize-export.ts`) and every
 * caller (viewer dialog, CLI) share one definition instead of drifting.
 *
 * Keyed by EXPRESS relationship name throughout (`IfcRelVoidsElement`, not
 * `voids`), per this repo's IFC-schema-fidelity rule: these ARE the
 * `IfcRel*` entity types the export walks, not a derived collection that
 * would need its own name.
 */

import type { RandomSource } from '@ifc-lite/encoding';

/**
 * Which relationship kinds `collectRelatedEntities` expands from the seed
 * selection, and how far. Every boolean defaults to what the doc comment
 * says, not to `false` — an omitted `RelatedEntityOptions` (or an omitted
 * field within one) must reproduce the bug the seed exhibits, which usually
 * needs its host/opening/type/material context, not a bare, disconnected
 * element.
 */
export interface RelatedEntityOptions {
  /** Openings of an included host element. Default `true`. */
  IfcRelVoidsElement?: boolean;
  /** The filler↔opening↔host chain (a window/door and the wall it sits in).
   *  Default `true`. */
  IfcRelFillsElement?: boolean;
  /**
   * Aggregate parents/children (`IfcRelAggregates`): `'up'` walks to
   * `RelatingObject` only, `'down'` to `RelatedObjects` only, `'both'` walks
   * both directions, `'none'` skips it. Default `'both'`.
   */
  IfcRelAggregates?: 'up' | 'down' | 'both' | 'none';
  /**
   * Nesting parents/children (`IfcRelNests`) — a separate EXPRESS
   * relationship from `IfcRelAggregates` even though the parser folds both
   * into the same aggregation edge type on `RelationshipGraph`; this option
   * is split out from the one above by REL ENTITY TYPE, not by graph edge,
   * so a caller can toggle them independently. Default `'down'`.
   */
  IfcRelNests?: 'up' | 'down' | 'both' | 'none';
  /** An included object's `IfcTypeObject` (`IfcRelDefinesByType`). Default `true`. */
  IfcRelDefinesByType?: boolean;
  /** An included object's material assignment (`IfcRelAssociatesMaterial`).
   *  Default `true`. */
  IfcRelAssociatesMaterial?: boolean;
  /**
   * The spatial containment chain (`IfcRelContainedInSpatialStructure`) up to
   * storey/building/site. Default `true`; regardless of this flag,
   * `IfcProject` is ALWAYS included — a STEP file with no project is not a
   * valid reproduction of anything.
   */
  IfcRelContainedInSpatialStructure?: boolean;
  /**
   * An included object's property sets (`IfcRelDefinesByProperties`).
   * Default `false` — psets are the majority of what this feature exists to
   * strip, so expanding them is opt-in, and turning this on still pulls in
   * `ePSet_MapConversion`/`ePSet_ProjectedCRS` style georeferencing psets
   * unless those are separately excluded.
   */
  IfcRelDefinesByProperties?: boolean;
  /**
   * BFS depth (both directions) to walk `IfcRelConnectsPathElements` from an
   * included element — e.g. a wall's structurally-connected neighbour.
   * Default `0` (no expansion).
   */
  IfcRelConnectsPathElementsDepth?: number;
}

/**
 * One relationship kind/direction's contribution to a `collectRelatedEntities`
 * result — e.g. "the openings reached via `IfcRelVoidsElement`, host role".
 */
export interface RelatedEntityGroup {
  /** EXPRESS relationship type name, e.g. `IfcRelVoidsElement`. */
  relationship: string;
  /** Which end of the relationship this group walked — e.g. `'opening'` /
   *  `'host'` for `IfcRelVoidsElement`, matching the doc at each walker's own
   *  call site rather than a fixed enum, since the meaningful roles differ
   *  per relationship kind. */
  role: string;
  /** ExpressIds of the related OBJECTS this group reached (never the
   *  `IfcRel*` relationship entity itself). */
  expressIds: number[];
  /** ExpressIds of the `IfcRel*` relationship entities that produced this
   *  group — these must ALSO be included in the export subset, or the
   *  association they represent has nothing naming it. */
  relationshipIds: number[];
}

/** The full result of one `collectRelatedEntities` call. */
export interface RelatedEntities {
  /** The caller's original seed selection, echoed back unfiltered. */
  seeds: number[];
  /** One entry per (relationship, role) that contributed anything, in walk
   *  order — the shape a UI groups a related-entity list by. */
  groups: RelatedEntityGroup[];
  /** The union of every id reached: seeds, every group's `expressIds`, and
   *  every group's `relationshipIds`. This — not any one group — is what a
   *  caller passes as `StepExportOptions.subsetEntityIds`. */
  all: Set<number>;
  /** `true` when the walk's work budget was exhausted before it reached a
   *  fixpoint (`Bounding walks over file-supplied references`, AGENTS.md) —
   *  the result is a valid, boundable subset of what a complete walk would
   *  have found, not the complete answer. */
  truncated: boolean;
}

/**
 * What to scrub, and how, when exporting the `subsetEntityIds` selection as
 * an anonymized STEP file. Every field defaults to the value stated in its
 * own doc comment (all `true`/enabled except where noted) — an anonymized
 * export with no options at all is the maximally-scrubbed one, since the
 * whole point of the feature is that a caller has to opt BACK IN to keep an
 * identifying signal, never opt in to remove one.
 */
export interface AnonymizeOptions {
  /** Replace `Name`/`LongName`/`Description`/`Tag` on every exported
   *  `IfcRoot` with a `<IfcType>-<n>` pseudonym. Default `true`. */
  pseudonymizeNames?: boolean;
  /** Also pseudonymize names OUTSIDE the `IfcRoot` text fields: `ObjectType`,
   *  `IfcTypeObject.ApplicableOccurrence`, `IfcElementType.ElementType` and
   *  `IfcProject.Phase` on roots, and every quoted-string `Name` /
   *  `Description` / `LongName` / `ProfileName` / `LayerSetName` / `Category`
   *  on non-`IfcRoot` entities — `Category` on ANY non-root class declaring it,
   *  `IfcMaterialProfile` and `IfcMaterialConstituent` included, not only
   *  `IfcMaterial` / `IfcMaterialLayer` —
   *  (`IfcSurfaceStyle`, `IfcMaterial*`, `IfcPresentationLayerAssignment`,
   *  `IfcProfileDef`, `IfcColourRgb`, …).
   *  A surface style called after the building it belongs to identifies the
   *  project as surely as `IfcProject.Name` does, and `ElementType` is the
   *  type-side twin of `ObjectType`, carrying the same authored text
   *  ("Basic Wall: <project> Exterior 300"). Enum-valued `Name`s
   *  (`IfcSIUnit.Name = .METRE.`) are never touched, nor are property /
   *  quantity names (schema semantics, only present under `keepPropertySets`)
   *  or `IfcApplication`. Default `true`; independent of `pseudonymizeNames`. */
  pseudonymizeAllNames?: boolean;
  /** Keep `IfcPropertySet`/`IfcElementQuantity` entities instead of dropping
   *  them. Default `false`: `exportAnonymizedSubset` excludes every such id
   *  from `includedIds` before export, however it got there (a caller's own
   *  `IfcRelDefinesByProperties` walk, or a hand-built id set) — the entity
   *  never reaches the output, values included, at any `includedIds` (#3351
   *  item 2). Property/quantity VALUES are unscrubbed by design, so setting
   *  this `true` keeps them exactly as authored; there is no partial,
   *  "kept but scrubbed" state. */
  keepPropertySets?: boolean;
  /** Regenerate every exported `IfcRoot`'s `GlobalId` (the old→new mapping
   *  comes back as `AnonymizeResult.guidMap`, never written into the file
   *  itself). Default `true`. */
  regenerateGlobalIds?: boolean;
  /** Zero the translation of each root `IfcLocalPlacement`
   *  (`PlacementRelTo = $`), preserving `Axis`/`RefDirection` and every child
   *  placement untouched. Default `true`. */
  zeroRootPlacement?: boolean;
  /** Remove `IfcMapConversion(Scaled)`/`IfcProjectedCRS` and blank
   *  `IfcSite`'s georeferencing/address attributes and
   *  `IfcBuilding.BuildingAddress`. Default `true`. */
  removeGeoreferencing?: boolean;
  /** Scrub the owner-history chain: blank `IfcPerson`/`IfcOrganization`
   *  identifying fields, zero `IfcOwnerHistory.CreationDate` and blank
   *  `LastModifiedDate`, blank `IfcApplication.Version` (a vendor build
   *  string such as `26.0.0 NOR FULL` encodes the licence region), and blank
   *  the STEP header's `originating_system`. `IfcApplication`'s name and
   *  identifier are kept — the authoring tool is debugging signal, its
   *  regional build is not. Default `true`. */
  scrubOwnerHistory?: boolean;
  /** Rewrite every `IfcMonetaryUnit.Currency` to US dollars (`.USD.` under
   *  IFC2X3's enum, `'USD'` under IFC4+'s label), so a cost-loaded model does
   *  not reveal its country. Default `true`. */
  neutralizeCurrency?: boolean;
  /** Seeded randomness for regenerated `GlobalId`s (and any other id this
   *  export synthesizes) — omitted means the platform CSPRNG, so two runs of
   *  an otherwise-identical anonymization differ in exactly those bytes.
   *  Pass the same source across repeat runs for byte-reproducible output. */
  guidRandom?: RandomSource;
  /** Pin the STEP header `FILE_NAME` timestamp (STEP format, e.g.
   *  `20240101T000000`). Omitted = the wall clock. */
  timeStamp?: string;
  /** Name recorded in the exported STEP header's `FILE_NAME` field — NOT
   *  necessarily the name the caller writes the file to disk under. Default
   *  `'anonymized.ifc'`, chosen because it is neutral: a caller that passes
   *  the real output path or project name here (e.g. `Acme-Tower.ifc`)
   *  defeats the anonymization by writing the identifying name straight back
   *  into the header of the file this option exists to scrub it from. */
  filename?: string;
}

/** The result of one `exportAnonymizedSubset` call. */
export interface AnonymizeResult {
  /** The anonymized STEP file content. */
  content: Uint8Array;
  /** Old `GlobalId` → new `GlobalId`, for every regenerated `IfcRoot`. Kept
   *  out of the exported file itself — it is exactly the mapping back to the
   *  original, identifying model, so it is the caller's responsibility to
   *  keep it separate (and typically NOT share it alongside the file). */
  guidMap: Map<string, string>;
  stats: {
    /** Total entities in the exported file. */
    entityCount: number;
    /** How many `IfcRoot` entities from `includedIds` actually made it into
     *  the export (after subset-root exclusion and relationship pruning). */
    includedRootEntityCount: number;
    /** ExpressIds of `IfcRel*` entities dropped because their mandatory,
     *  single-valued reference named an entity the exclusion left out —
     *  `relationshipRefsSurviveExclusion` (`reference-collector.ts`) already
     *  decides this for the closure walk; this is that same decision,
     *  reported so a caller can see WHICH associations the anonymization
     *  cost, not just that some file that changed. */
    prunedRelationshipIds: number[];
    /** ExpressIds of `IfcPropertySet`/`IfcElementQuantity` entities excluded
     *  from `includedIds` because `keepPropertySets` was falsy (the
     *  default) — reported distinctly, the same way `prunedRelationshipIds`
     *  is, so a caller can tell "this id is missing because it is a
     *  property set" from any other exclusion reason without grepping
     *  `warnings` text. Empty when `keepPropertySets` was `true`. */
    droppedPropertySetIds: number[];
    /** ExpressIds of emitted `IfcPropertyReferenceValue` entities whose
     *  optional `PropertyReference` was nulled because it named an entity the
     *  subset excluded. */
    droppedPropertyReferenceIds: number[];
    /** Each root `IfcLocalPlacement` this export zeroed, and the translation
     *  it zeroed (the ORIGINAL, pre-zero coordinates) — reported because the
     *  translation was real coordinate data the caller may still want to log
     *  or compare against, even though it is deliberately not in the file. */
    zeroedPlacements: { expressId: number; translation: number[] }[];
    /** Non-fatal notices: a placement chain this export could not safely
     *  zero (e.g. an `IfcGridPlacement`/`IfcLinearPlacement` root, left
     *  untouched), multiple root placements collapsing onto one origin, or
     *  anything else `AnonymizeOptions` asked for that this export could not
     *  fully deliver. Same `string[]` shape as
     *  `StepExportResult.stats.warnings`. */
    warnings: string[];
  };
}
