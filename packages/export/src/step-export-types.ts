/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The vocabulary of a STEP export: what a caller asks for, what it gets back,
 * and the state one `export()` call threads through its phases.
 *
 * Split out of `step-exporter.ts` for #2475. These are declarations only -- no
 * behaviour lives here beyond one message builder -- which is why they could
 * move without touching a single guard.
 *
 * Two ways in, deliberately. The seven sibling modules that already imported
 * `ExportPass` / `SourceLineMutations` still import them from
 * `step-exporter.js`, which re-exports this file, so no existing call site
 * moved and the package's public entry point is untouched. Code written since
 * the split imports straight from here instead -- `step-pass-builder.ts` does
 * -- because the re-export exists to avoid churning callers, not as a channel
 * anything new should be routed through.
 */

import type { IfcAttributeValue, IfcSourceHeader, MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { PropertySet, QuantitySet } from '@ifc-lite/data';
import type { RandomSource } from '@ifc-lite/encoding';
import type { IfcSchemaVersion } from './schema-converter.js';
import type { ModificationLedger, SourceLineDelivery } from './delta-modification-ledger.js';
import type { EffectiveEntityIndex } from './effective-index.js';
// A function, referenced only in type position: `ExportPass.isReadableSourceRef`
// is `ReturnType<typeof createSourceRefReader>` rather than a restatement of the
// shape, so the reader and its consumers cannot drift apart. `import type` is
// therefore correct and deliberate -- nothing here calls it, and the import
// erases.
import type { createSourceRefReader } from './source-ref-bounds.js';

/**
 * Options for STEP export
 */
export interface StepExportOptions {
  /** IFC schema version for the output file (any version, will convert if needed) */
  schema: 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';
  /** File description */
  description?: string;
  /** Author name */
  author?: string;
  /** Organization name */
  organization?: string;
  /**
   * FILE_NAME `authorization` slot override. Omitted = the source header's
   * own authorization token, unchanged (see `buildStepHeader`); there was no
   * caller-facing way to override or blank it before this (#2934, part of the
   * anonymized-export header scrub — an unblanked authorization line would
   * leak whatever the source file's steward wrote there).
   */
  authorization?: string;
  /**
   * FILE_NAME `originating_system` slot override. Omitted = the source
   * header's own value, unchanged. The anonymized export blanks it: a vendor
   * build string like `<tool> 26.0.0 NOR FULL` encodes the licence region.
   */
  originatingSystem?: string;
  /** Application name (defaults to 'ifc-lite') */
  application?: string;
  /** Output filename */
  filename?: string;

  /** Include original geometry entities (default: true) */
  includeGeometry?: boolean;
  /** Include property sets (default: true) */
  includeProperties?: boolean;
  /** Include quantity sets (default: true) */
  includeQuantities?: boolean;
  /** Include relationships (default: true) */
  includeRelationships?: boolean;

  /** Apply mutations from MutablePropertyView (default: true if provided) */
  applyMutations?: boolean;
  /** Only export entities with mutations (delta export) */
  deltaOnly?: boolean;

  /** Only export entities currently visible in the viewer */
  visibleOnly?: boolean;
  /** Hidden entity IDs (local expressIds) — required when visibleOnly is true */
  hiddenEntityIds?: Set<number>;
  /** Isolated entity IDs (local expressIds, null = no isolation active) */
  isolatedEntityIds?: Set<number> | null;

  /**
   * Export exactly these `IfcRoot`-derived entities plus infrastructure and
   * their forward closure; every other `IfcRoot` entity (and each
   * `IDENTIFYING_TYPES` entity — postal/telecom address, georeferencing) is
   * excluded and stripped from relationship lines by the same dangling-ref
   * protection `visibleOnly` gets (`evaluateOmissionPredicates` +
   * `filterHiddenRefsFromRelationshipLine`, both driven off
   * `pass.allowedEntityIds`/`hiddenProductIds`). Mutually exclusive with
   * `visibleOnly` — `collectModifications` throws if both are set. The seed
   * set for the anonymized-subset export (#2934); see `subset-roots.ts`'s
   * `getSubsetEntityIds`.
   */
  subsetEntityIds?: ReadonlySet<number>;
  /** Which identifying classes the subset closure excludes. Defaults to all of
   *  `IDENTIFYING_TYPES`. The anonymize path narrows it when the caller asked
   *  to KEEP georeferencing and addresses: dropping them anyway left an
   *  `IfcSite.SiteAddress` pointing at a line that was never written (#3351). */
  subsetIdentifyingTypes?: ReadonlySet<string>;

  /** Georeferencing mutations to apply (IfcProjectedCRS / IfcMapConversion edits) */
  georefMutations?: {
    projectedCRS?: Partial<ProjectedCRS>;
    mapConversion?: Partial<MapConversion>;
  };

  /**
   * Seeded randomness for the GlobalIds this exporter SYNTHESIZES:
   * the `IfcPropertySet` / `IfcElementQuantity` roots regenerated for
   * mutated (or overlay-created) property and quantity sets, their
   * `IfcRelDefinesByProperties` links. Without it those come from the platform
   * CSPRNG, so two exports of the same model differ in exactly those bytes -
   * which breaks byte-reproducibility for in-store builds that call
   * `addPropertySet` / `addQuantitySet` (the sets themselves live in the
   * mutation overlay and only become IFC roots here). Pass the same seeded
   * source used for `SpatialAnchor.guidRandom` to close that gap. Default
   * (omitted) behaviour for THESE ids is unchanged: random.
   *
   * NOT the `IFCPROXY` placeholders any more (#2733). Those used to be minted
   * from this source too, so an omitted `guidRandom` made every downgraded
   * IFC4X3 entity differ on re-export. They are now derived from the source
   * line when this is omitted, and only fall back to this source when it is
   * supplied - so passing a seeded source still pins them, but NOT passing one
   * no longer makes them random. See `convertStepLine`.
   */
  guidRandom?: RandomSource;
  /**
   * Pin the STEP header `FILE_NAME` timestamp (STEP format, e.g.
   * `20240101T000000`). Omitted = the wall clock, as before. Required for
   * genuinely byte-identical exports, since the header otherwise carries the
   * export instant.
   */
  timeStamp?: string;

  /** Progress callback for async export */
  onProgress?: (progress: StepExportProgress) => void;
}

/**
 * Progress information during STEP export
 */
export interface StepExportProgress {
  /** Current phase of export */
  phase: 'preparing' | 'entities' | 'assembling';
  /** Progress 0-1 */
  percent: number;
  /** Number of entities processed so far */
  entitiesProcessed: number;
  /** Total entities to process */
  entitiesTotal: number;
}

/**
 * Result of STEP export
 */
export interface StepExportResult {
  /** STEP file content as bytes (avoids V8 string length limit for large files) */
  content: Uint8Array;
  /** Statistics about the export */
  stats: {
    /** Total entities exported */
    entityCount: number;
    /** New entities created for mutations */
    newEntityCount: number;
    /** Entities modified by mutations */
    modifiedEntityCount: number;
    /** File size in bytes */
    fileSize: number;
    /**
     * Non-fatal refusals: things the caller asked for that this export could
     * not write. Empty when the export did everything it was asked to do.
     *
     * A requested `georefMutations.mapConversion` is one case: with no
     * `IfcGeometricRepresentationContext` to reference as `SourceCRS`, the
     * `IfcMapConversion` is skipped (writing it would produce a dangling
     * reference) while the `IfcProjectedCRS` is still written — so the output
     * is indistinguishable from "no map conversion was requested" unless the
     * caller reads this (#2067).
     *
     * A WITHHELD RELATIONSHIP is the other: when a relationship names an
     * entity this export is not writing, in a slot with no spelling for an
     * omitted reference, the whole relationship line is dropped rather than
     * shipped dangling — see {@link relationshipWithheldWarning}. This can
     * happen on a plain full export with no options set at all, so it is
     * reported rather than left to be discovered by a diff.
     *
     * Same `string[]` shape as `MergeExportResult.stats.warnings`.
     */
    warnings: string[];
  };
}

/**
 * Message for a relationship this export DROPPED rather than rewrote.
 *
 * `filterHiddenRefsFromRelationshipLine` removes an omitted `#N` from a
 * SET/LIST attribute, but a single-valued attribute has no STEP spelling for
 * "omitted" and an empty SET is not the same statement as the original — so in
 * both of those cases it withholds the whole line and the relationship simply
 * is not in the output. Withholding beats shipping a dangling `#N`, but it is
 * not free: every OTHER entity that relationship named loses the association.
 * A visible element can therefore come out of a plain full export with one
 * fewer pset than it went in with, and before this warning existed nothing in
 * the result said so (adversarial review of #2668).
 *
 * Deliberately reports the relationship rather than the omitted target: the
 * target's own omission is already the caller's own doing in every reason but
 * the unreadable-ref one, whereas the lost association is the surprise.
 */
export const relationshipWithheldWarning = (expressId: number, type: string): string =>
  `Relationship #${expressId} (${type}) was withheld from the export: it names at least one entity that has no line in this export, in a slot with no spelling for an omitted reference (a single-valued attribute, or a set whose every member is omitted). Anything else that relationship associated is no longer associated in the output.`;

/**
 * What `step-attribute-mutations.ts`'s `applySourceLineMutations` produced: the rewritten
 * line, plus which edit kinds that rewrite actually delivered. The delivery
 * half is {@link SourceLineDelivery} rather than three loose booleans so that
 * the pipeline and the ledger cannot disagree about what a source line carries
 * — an added kind has one place to be added.
 */
export type SourceLineMutations = SourceLineDelivery & { text: string };

/**
 * The state one `export()` call shares across its seven phases.
 *
 * Introduced by step 1 of #2475: `export()` is ~1267 lines and the phases a
 * split would separate are held together by ~30 local bindings, most of which
 * are read in three or more phases. Naming that set once — as an interface
 * with a single construction site at the top of `export()` — is what lets a
 * later phase extraction take one parameter instead of fifteen.
 *
 * Two properties of this object are load-bearing and must survive every later
 * move:
 *
 * 1. **The predicates are members, not duplicated expressions.** Six of them
 *    (`isOverlayCreated`, `isReadableSourceRef`, `isGeometryExcluded`,
 *    `hasEmittableHostBytes`, `willBeEmitted`,
 *    `isRefExcludedDuringClosureWalk`) exist precisely so two phases cannot
 *    disagree about a gate — see the comments at their construction sites for
 *    the corrupt files the earlier, per-phase versions let through (#2491,
 *    #2414, #2398, #2637). A phase that reimplements one of these instead of
 *    reading it off the pass reintroduces exactly that class of defect.
 * 2. **`allowedEntityIds` and `hiddenProductIds` are mutable, and the
 *    predicates close over the pass rather than over a snapshot.** Both are
 *    assigned AFTER construction, in `step-collection.ts`, and the order there
 *    matters more than it looks: `hiddenProductIds` is set first, and
 *    `allowedEntityIds` is the value the closure walk on the next line is
 *    computing — so `isRefExcludedDuringClosureWalk` is handed to that walk
 *    as one of that call's own arguments — while `allowedEntityIds`, and only
 *    it, is still null. The
 *    output-line filter reads both later, through `isOmittedFromOutput` ->
 *    `willBeEmitted`, so neither can be a snapshot taken before the walk ran —
 *    that is the invariant the #2637 regression broke.
 *
 * Deliberately NOT on the pass, and why: `isOmittedFromOutput`,
 * `mayNameOmittedRefs` and
 * `overlayNewEntityCount` are eagerly-computed values whose value is only
 * defined after work that runs past this construction site, so hoisting them
 * would change what they compute rather than where they are named;
 * `generatedTypeOwnedPsetIds` is read in one phase only — a local inside
 * `step-property-sets.ts:generatePropertyAndQuantitySetEntities`, which holds
 * both the loop that writes it and the loop that reads it (#2475).
 */
export interface ExportPass {
  /** Output accumulator: every DATA-section line this export will write. */
  readonly entities: string[];
  /** Lines contributed by entities that have no source record. */
  newEntityCount: number;

  // ---- resolved options / schema ----
  readonly schema: IfcSchemaVersion;
  readonly sourceSchema: IfcSchemaVersion;
  readonly converting: boolean;
  readonly sourceHeader: IfcSourceHeader | undefined;
  readonly schemaToken: string;
  readonly overlayActive: boolean;

  // ---- indexes and ledgers ----
  readonly effective: EffectiveEntityIndex;
  readonly modifications: ModificationLedger;
  /** Widened from the imported `InPlaceNominees` (whose sets are readonly)
   *  because the collection passes below add to them. */
  readonly inPlaceNominees: { attribute: Set<number>; georeferencing: Set<number> };

  // ---- visible-only closure results (assigned after construction) ----
  allowedEntityIds: Set<number> | null;
  hiddenProductIds: ReadonlySet<number> | null;

  // ---- the collection passes' output ----
  readonly modifiedEntities: Set<number>;
  readonly modifiedAttributes: Map<number, Map<string, string>>;
  readonly newPropertySets: Array<{ entityId: number; psets: PropertySet[] }>;
  readonly newQuantitySets: Array<{ entityId: number; qsets: QuantitySet[] }>;
  readonly typeOwnedPsetNamesByEntity: Map<number, Set<string>>;
  readonly typeOwnedPsetIdsByEntity: Map<number, number[]>;
  readonly rewrittenEntityIds: Set<number>;
  readonly rewrittenEntityLines: Map<number, string>;
  readonly overlayTypeOwnedPsets: Map<number, IfcAttributeValue>;
  readonly skipPropertySetIds: Set<number>;
  readonly skipRelationshipIds: Set<number>;
  readonly newGeorefLines: string[];
  readonly warnings: string[];

  // ---- the shared predicates (see item 1 above) ----
  readonly buildHeader: (modifications: number) => string;
  readonly isOverlayCreated: (entityId: number) => boolean;
  readonly isReadableSourceRef: ReturnType<typeof createSourceRefReader>;
  readonly isGeometryExcluded: (entityId: number, recordType: string) => boolean;
  readonly hasEmittableHostBytes: (entityId: number) => boolean;
  readonly willBeEmitted: (entityId: number) => boolean;
  readonly isRefExcludedDuringClosureWalk: (id: number) => boolean;
}
