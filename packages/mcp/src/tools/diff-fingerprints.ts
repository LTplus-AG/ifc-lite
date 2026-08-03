/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The MCP server's adapter onto the real `@ifc-lite/diff` engine (issue #1891).
 *
 * `model_diff` on its own answers "what changed at the type and identity
 * level" — counts per type, GlobalIds added and removed. That answer is wrong
 * in the most damaging way the moment the two models came from a from-scratch
 * re-export: every GlobalId is new, so the whole model reads as
 * deleted-and-added. `by_content: true` routes the same two loaded models
 * through the engine's content-keyed matching pass instead.
 *
 * **Data scope only, on purpose.** Node has no geometry pipeline here: no
 * meshes, so no world geometry hash and no bounding box. Rather than pretend
 * otherwise the handler passes `scope: 'data'`, which is the honest description
 * of what it can see — the engine then classifies every unambiguous 1:1 content
 * match as `renamed` and reports every genuinely ambiguous group as a group,
 * exactly as it does for a viewer session whose geometry hashing was
 * unavailable.
 *
 * **Scope of the comparison: every `IfcObjectDefinition` in the model.** IFC's
 * three `IfcRoot` branches are not equally comparable. An `IfcObjectDefinition`
 * (every `IfcObject` — product, task, actor, control, resource, group — plus
 * `IfcTypeObject` and `IfcContext`) is an independently identifiable thing. The
 * other two branches are dependent and stay out:
 *
 * - `IfcRelationship`: its identity is its endpoints. Re-GUIDing an
 *   `IfcRelAggregates` while both ends are untouched is not a change anyone
 *   wants reported.
 * - `IfcPropertyDefinition`: a property set's content is already folded into
 *   its owner's `dataHash`, so comparing it again would double-report every
 *   edited property — once on the element, once on the pset.
 *
 * Membership is decided from the inheritance chain of every bundled schema
 * (IFC2X3 + IFC4 + IFC4X3), not from whether the columnar parser happened to
 * put the entity in its `EntityTable`, and not from the IFC4 codegen pin alone.
 * That distinction is the whole fix for a class of silent drop-outs: the table
 * only holds the categories the viewer renders, so `IfcTask`, `IfcActor`,
 * `IfcWorkPlan` and every other non-product `IfcObject` reported an empty
 * GlobalId and vanished from the comparison entirely, even though their STEP
 * records carry one. Those are read straight from the source record instead.
 * (`by_entity` on the same tool still asks the store and so still misses them;
 * that is pre-existing behaviour of a different flag, untouched here.)
 *
 * The same distinction closes the drop-out's mirror image. The parser fills the
 * table's GlobalId column positionally, and for a resource entity slot 0 is not
 * a GlobalId: an `IfcMaterial`, `IfcSurfaceStyle`, `IfcClassification` or
 * `IfcProjectedCRS` was being compared under its *Name*, which put colliding
 * keys into the comparison — a material and a surface style of the same name
 * arriving as one entity. None of them is an `IfcRoot`, so the chain check
 * leaves them out and the key set is unique again.
 *
 * ## Why this is a second copy, and what stops it drifting
 *
 * `packages/cli/src/commands/diff-engine.ts` and its `diff-scope.ts` are the
 * same adapter, and the two must stay behaviourally identical — a fingerprint
 * means nothing unless both producers compute it the same way. It is duplicated
 * rather than shared because there is no honest home for it yet:
 *
 * - `@ifc-lite/cli` already depends on `@ifc-lite/mcp`, so this package cannot
 *   import from there without a cycle.
 * - `@ifc-lite/diff` is deliberately store-agnostic and dependency-free; giving
 *   it a runtime dependency on `@ifc-lite/parser` to host an adapter would undo
 *   the property that lets the viewer, the CLI and this server each supply
 *   their own.
 * - `@ifc-lite/parser` must not learn about diffing. The *scope* walk is close
 *   to parser-domain — it exists to compensate for the columnar parser's own
 *   `EntityTable` gaps — but which `IfcRoot` branches a comparison may speak
 *   for is diff policy, and exporting that from the most-depended-on package
 *   under a neutral name would only rename the problem.
 *
 * That leaves a fourth package both could depend on, which is a published
 * artefact and a release decision rather than a review fix.
 *
 * Until then the agreement is **asserted, not assumed**. The copies previously
 * relied on parallel suites (`diff.test.ts` here, `diff-content.test.ts` in the
 * CLI) checking the same behaviour separately, which cannot detect a drift:
 * fixing one copy and not the other passes both. It took hours to find out —
 * #2001 moved the CLI's membership check to the cross-schema inheritance lookup
 * and this copy stayed on the IFC4 codegen pin, silently dropping every IFC2X3
 * and IFC4X3 object class outside that pin. `diff-fingerprints.test.ts` now runs
 * *both* copies over the CLI's own fixtures and requires the same entities under
 * the same type names, so the next divergence fails a build instead of shipping.
 *
 * The one thing this copy has and the CLI's does not is the optional
 * `overlay` argument. It is additive, not a divergence: a `model_id` on this
 * server names a session that may carry queued mutations, and the CLI diffs two
 * files that cannot. Called without it, the two copies compute byte-identical
 * fingerprints, which is what the paired tests check.
 */

import {
  buildComponentFingerprints,
  buildDataFingerprint,
  type DataFingerprintInput,
  type EntityFingerprint,
} from '@ifc-lite/diff';
import { RelationshipType } from '@ifc-lite/data';
import {
  EntityExtractor,
  extractAllEntityAttributes,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractRootAttributesFromEntity,
  getInheritanceChainAcrossSchemas,
  type IfcDataStore,
} from '@ifc-lite/parser';
import type { CreatedEntity, PendingOverlay } from '../overlay.js';

/** Adapter handle threaded through the diff: the entity's express id. */
export type DiffRef = number;

/** The IfcRoot-family attributes a fingerprint needs when the columnar
 *  `EntityTable` does not hold the entity. */
type RootAttributes = ReturnType<typeof extractRootAttributesFromEntity>;

/** How an uppercase STEP type participates in the comparison. `name` is the
 *  registry's PascalCase spelling, used instead of the `EntityTable`'s
 *  `'Unknown'` for entities the table never took in. */
interface TypeRole {
  role: 'independent' | 'dependent' | 'unknown';
  name: string;
}

/**
 * Classify one STEP type against the three `IfcRoot` branches.
 *
 * The chain has to come from **every bundled schema**, not from the parser's
 * IFC4 codegen pin. `getInheritanceChainForEntity` answers an empty chain for
 * any class the pin does not carry, and that is not a rare corner: IFC2X3 alone
 * puts 23 `IfcObjectDefinition` classes there (`IfcMove`, `IfcOrderAction`,
 * `IfcScheduleTimeControl`, `IfcSpaceProgram`, `IfcServiceLife`, …) and IFC4X3
 * another 77. Judging those as `unknown` dropped the ones the `EntityTable`
 * does not hold — real objects with real GlobalIds — and let through the
 * IFC2X3-only *resource* classes it does hold under a `…STYLE` name, keyed on
 * the Name in slot 0. Both are wrong answers about an IFC2X3 file, which is
 * still most of what is in the wild.
 *
 * `unknown` is still not `dependent`: a vendor extension no schema declares has
 * no chain to judge, so it keeps exactly the reach the `EntityTable` already
 * gave it — which for a `…TYPE` class is a genuine GlobalId, since the parser's
 * type-object branch is name-based and takes those in. Guessing that an
 * unrecognised class is an `IfcObject` and reading its source record instead
 * would cost one STEP extraction per row of every unrecognised bucket in the
 * model, on every call, to reach entities almost no file has. The price of that
 * choice is that a vendor `IfcRoot` subtype whose name does not end in `TYPE`
 * stays uncompared.
 *
 * The one name the chain is not needed for is `IFCREL…`: that prefix is the
 * parser's own rule for taking an unrecognised relationship into the table, and
 * a relationship is excluded here whether any schema can confirm it or not.
 * Without this, an unrecognised `IfcRelXxx` would be the single class of entity
 * that got in through the relationship branch the comparison deliberately shuts.
 */
function classifyType(typeKey: string): TypeRole {
  const upper = typeKey.toUpperCase();
  const chain = getInheritanceChainAcrossSchemas(upper);
  if (chain.length === 0) {
    return { role: upper.startsWith('IFCREL') ? 'dependent' : 'unknown', name: typeKey };
  }
  // The chain holds the class itself plus its supertypes; which end the leaf
  // sits at is the schema source's business — the union walk answers leaf→root
  // and the IFC4 pin it falls back to answers root→leaf — so find it by name.
  const name = chain.find((ancestor) => ancestor.toUpperCase() === upper) ?? typeKey;
  if (!chain.includes('IfcRoot')) return { role: 'dependent', name };
  return { role: chain.includes('IfcObjectDefinition') ? 'independent' : 'dependent', name };
}

/**
 * Build one {@link EntityFingerprint} per `IfcObjectDefinition` in a store.
 *
 * `components` is populated as well as `dataHash`: the content pass's only
 * defence against a `dataHash` collision retiring an unrelated add/delete pair
 * is agreement on `ifcType` and on every component sub-hash, and the second
 * check is inert unless both sides supply them (see the "Hash collisions"
 * section of `docs/guide/model-diff.md`).
 *
 * Pass `overlay` to fingerprint the model *as the session has it* rather than
 * as the file was parsed — tombstoned entities drop out, created ones join, and
 * edited names, descriptions and property values are hashed at their new
 * values. Omitting it (the CLI twin has no session to overlay) is the original
 * store-only behaviour exactly.
 */
export function buildModelFingerprints(
  store: IfcDataStore,
  overlay?: PendingOverlay | null,
): EntityFingerprint<DiffRef>[] {
  const fingerprints: EntityFingerprint<DiffRef>[] = [];
  const seen = new Set<number>();
  // One extractor for the whole model: it holds a buffer reference, and the
  // source read below only fires for the (small) set of object types the
  // EntityTable declines to hold.
  const extractor = new EntityExtractor(store.source);

  for (const [typeKey, ids] of store.entityIndex.byType) {
    // Classified once per type rather than once per entity — the geometry
    // buckets (IfcCartesianPoint, IfcPolyLoop, …) are the bulk of a real model
    // and are dismissed here without touching a single row.
    const type = classifyType(typeKey);
    if (type.role === 'dependent') continue;

    for (const expressId of ids) {
      if (seen.has(expressId)) continue;
      seen.add(expressId);
      // Queued for deletion: the session no longer has this entity, so the
      // comparison must not keep reporting it as present and unchanged.
      if (overlay?.deleted.has(expressId)) continue;

      let globalId = store.entities.getGlobalId(expressId);
      let source: RootAttributes | undefined;
      if (!globalId && type.role === 'independent') {
        // In the model but not in the table: a schedule task, an actor, a work
        // plan. Its GlobalId is in the STEP record, so read it there.
        source = readRootAttributes(extractor, store, expressId);
        globalId = source?.globalId ?? '';
      }
      // Still nothing: the entity is not an IfcRoot at all (a placement, a
      // profile, a representation item), so it has no cross-model identity.
      if (!globalId) continue;

      const tableType = store.entities.getTypeName(expressId);
      // `getTypeName` answers 'Unknown' for a row the table never took in. The
      // registry's own spelling is the honest answer, and it has to be a real
      // type name: `ifcType` is hashed into the fingerprint and cross-checked
      // on every content match, so 'Unknown' would pair a task with an actor.
      const ifcType = source && (!tableType || tableType === 'Unknown') ? type.name : tableType;
      const input = buildDataInput(store, expressId, ifcType, source, overlay);
      fingerprints.push({
        key: globalId,
        ifcType,
        dataHash: buildDataFingerprint(input),
        components: buildComponentFingerprints(input),
        ref: expressId,
      });
    }
  }

  for (const entity of overlay?.created ?? []) {
    const fingerprint = createdFingerprint(entity, overlay as PendingOverlay);
    if (fingerprint) fingerprints.push(fingerprint);
  }

  return fingerprints;
}

/**
 * Fingerprint one overlay-created entity (`entity_create`).
 *
 * It goes through the same `classifyType` gate as a stored entity — a created
 * `IfcRelAggregates` stays out of the comparison exactly as a parsed one does,
 * and an unrecognised class keeps the same reach the store path gives it — and
 * its `ifcType` is the registry's spelling. The caller may have authored the
 * STEP-uppercase form, and `ifcType` is hashed and cross-checked on every
 * content match, so `IFCWALL` would never pair with `IfcWall`.
 *
 * Its attributes come from the same place a stored entity's do: the creation
 * payload is only the *base*, which `entity_set_attribute` overrides exactly as
 * it overrides a parsed record (see {@link buildDataInput}). Create-then-rename
 * is an ordinary two-step, and reading the frozen payload made this the one
 * fingerprint in the model describing a value the session no longer holds — a
 * rename went unseen, a clear was hashed as the name it cleared. All three
 * hashed IfcRoot attributes: `Name` and `Description` have a payload behind them
 * (STEP slots 0/2/3 are fixed across `IfcRoot` subtypes), `ObjectType` has none
 * (slot 4 is `ApplicableOccurrence` on an `IfcTypeObject`) and so exists only as
 * an override. `Tag` is the fourth the tool accepts and no fingerprint field
 * carries it. Property sets and quantities never had the asymmetry — both were
 * already read through the overlay.
 *
 * `predefinedType` and `typeAssignments` are necessarily absent: both are read
 * through the store, which has no row for an entity that exists only in the
 * overlay, and neither is reachable through `entity_set_attribute`. A created
 * entity that would have matched on those alone therefore reports as added
 * rather than matched, which is the safe direction.
 */
function createdFingerprint(
  entity: CreatedEntity,
  overlay: PendingOverlay,
): EntityFingerprint<DiffRef> | null {
  const type = classifyType(entity.ifcType);
  if (type.role === 'dependent') return null;
  const edited = overlay.attributes(entity.expressId);
  const input: DataFingerprintInput = {
    ifcType: type.name,
    name: override(edited.get('Name'), entity.name),
    description: override(edited.get('Description'), entity.description),
    objectType: override(edited.get('ObjectType'), undefined),
    propertySets: overlay.propertySets(entity.expressId).map((set) => ({
      name: set.name,
      properties: set.properties.map((property) => ({ name: property.name, value: property.value })),
    })),
    quantitySets: overlay.quantitySets(entity.expressId).map((set) => ({
      name: set.name,
      quantities: set.quantities.map((quantity) => ({
        name: quantity.name,
        value: roundQuantity(quantity.value),
      })),
    })),
    typeAssignments: [],
  };
  return {
    key: entity.globalId,
    ifcType: type.name,
    dataHash: buildDataFingerprint(input),
    components: buildComponentFingerprints(input),
    ref: entity.expressId,
  };
}

/** IfcRoot attributes straight from the entity's STEP record, for the rows the
 *  columnar `EntityTable` never took in. */
function readRootAttributes(
  extractor: EntityExtractor,
  store: IfcDataStore,
  expressId: number,
): RootAttributes | undefined {
  const ref = store.entityIndex.byId.get(expressId);
  if (!ref) return undefined;
  const entity = extractor.extractEntity(ref);
  return entity ? extractRootAttributesFromEntity(entity) : undefined;
}

/**
 * Assemble the canonical {@link DataFingerprintInput} for one entity.
 *
 * Mirrors the viewer adapter (`apps/viewer/src/lib/compare/buildFingerprints.ts`)
 * minus its geometry-data filtering: that filter exists to keep placement data
 * out of the *data* hash so a pure move reads as a geometry-only change, and
 * this path has no geometry hash for such a change to land in. Dropping the
 * filter here would make a moved element look unchanged.
 */
function buildDataInput(
  store: IfcDataStore,
  expressId: number,
  ifcType: string,
  /** Set only when the entity is absent from the columnar `EntityTable`, whose
   *  accessors then answer '' for every display attribute. */
  source: RootAttributes | undefined,
  /** Set when the session has queued edits; its reads are base-merged, so it
   *  replaces the store read rather than being layered on top of it. */
  overlay: PendingOverlay | null | undefined,
): DataFingerprintInput {
  const predefinedType = extractAllEntityAttributes(store, expressId).find(
    (attribute) => attribute.name === 'PredefinedType',
  )?.value;
  const edited = overlay?.attributes(expressId);

  const propertySets = (overlay
    ? overlay.propertySets(expressId)
    : extractPropertiesOnDemand(store, expressId)
  ).map((set) => ({
    name: set.name,
    properties: set.properties.map((property) => ({ name: property.name, value: property.value })),
  }));

  const quantitySets = (overlay
    ? overlay.quantitySets(expressId)
    : extractQuantitiesOnDemand(store, expressId)
  ).map((set) => ({
    name: set.name,
    quantities: set.quantities.map((quantity) => ({
      name: quantity.name,
      // Rounded to 4 dp, matching the viewer: re-exporting a model with
      // sub-tolerance float jitter must not flip the data hash on an otherwise
      // identical element, which on this path would cost the pair its match.
      value: roundQuantity(quantity.value),
    })),
  }));

  const typeAssignments = store.relationships
    .getRelated(expressId, RelationshipType.DefinesByType, 'inverse')
    .map((typeId: number) => ({
      globalId: store.entities.getGlobalId(typeId) || undefined,
      name: store.entities.getName(typeId) || undefined,
      type: store.entities.getTypeName(typeId) || undefined,
    }));

  return {
    ifcType,
    // The hash sees these three of the four `entity_set_attribute` accepts;
    // `Tag` is not a fingerprint field. The overlay carries all of them, so the
    // selection happens here, at the consumer that has a reason for it, rather
    // than in the projection where it silently starved the readback (#2014).
    name: override(edited?.get('Name'), store.entities.getName(expressId) || source?.name),
    description: override(edited?.get('Description'), store.entities.getDescription(expressId) || source?.description),
    objectType: override(edited?.get('ObjectType'), store.entities.getObjectType(expressId) || source?.objectType),
    predefinedType: predefinedType != null ? String(predefinedType) : undefined,
    propertySets,
    quantitySets,
    typeAssignments,
  };
}

function roundQuantity(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : value;
}

/**
 * An overlay override wins whenever one exists, including when it is empty —
 * `entity_set_attribute` with `''` clears the attribute, and falling back to
 * the stored value there would hash the edit away.
 */
function override(edited: string | undefined, stored: string | undefined): string | undefined {
  const value = edited !== undefined ? edited : stored;
  return value ? value : undefined;
}
