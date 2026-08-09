/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which entities of a file take part in an `ifc-lite diff`, and under what key
 * (issue #1891).
 *
 * One answer for both comparison modes: `--by-entity`, which reports GlobalIds
 * added / removed / common, and `--by-content`, which fingerprints the same
 * entities for the `@ifc-lite/diff` engine (see `diff-engine.ts`). They were
 * two answers, and the older one was wrong in ways the user could not see.
 *
 * **Scope: every `IfcObjectDefinition` in the file.** IFC's three `IfcRoot`
 * branches are not equally comparable. An `IfcObjectDefinition` (every
 * `IfcObject` — product, task, actor, control, resource, group — plus
 * `IfcTypeObject` and `IfcContext`) is an independently identifiable thing, and
 * is precisely what a diff can make a claim about. The other two branches are
 * dependent and stay out:
 *
 * - `IfcRelationship`: its identity is its endpoints. Re-GUIDing an
 *   `IfcRelAggregates` while both ends are untouched is not a change anyone
 *   wants reported, and on a re-export it is most of the reported churn.
 * - `IfcPropertyDefinition`: a property set's content already travels with its
 *   owner, so comparing it again double-reports every edited property — once on
 *   the element, once on the pset.
 *
 * **Membership is decided from the inheritance chain of every bundled schema**
 * (IFC2X3 + IFC4 + IFC4X3), not from what the columnar parser happened to put
 * in its `EntityTable`, not from whichever attribute sits in slot 0 of a STEP
 * record, and not from the IFC4 codegen pin alone. That is the whole fix for
 * two silent defects:
 *
 * 1. The parser fills the table's GlobalId column positionally, and slot 0 of a
 *    resource entity is a **Name**. An `IfcMaterial`, `IfcSurfaceStyle`,
 *    `IfcClassification` or `IfcProjectedCRS` was therefore compared under its
 *    name — and two of them sharing a name arrived as one entity. On the four
 *    bundled sample models that was 4-9 colliding keys and 16-25 non-`IfcRoot`
 *    entries per file. None of them is an `IfcRoot`, so the chain check leaves
 *    them out and the key set is unique again.
 * 2. The `EntityTable` only holds the categories the viewer renders, so
 *    `IfcTask`, `IfcActor`, `IfcWorkPlan` and every other non-product
 *    `IfcObject` answer '' from `getGlobalId` even though their STEP records
 *    carry one. Those are read straight from the source record here.
 *
 * Classification happens once per *type*, so the geometry buckets — which are
 * the bulk of a real file — are dismissed without touching a single row.
 */

import {
  EntityExtractor,
  extractRootAttributesFromEntity,
  getInheritanceChainAcrossSchemas,
  type IfcDataStore,
} from '@ifc-lite/parser';

/** The IfcRoot-family attributes read from a STEP record when the columnar
 *  `EntityTable` does not hold the entity. */
export type RootAttributes = ReturnType<typeof extractRootAttributesFromEntity>;

/** One entity that takes part in the comparison. */
export interface ComparableEntity {
  expressId: number;
  /** Non-empty by construction: an entity without one has no cross-file
   *  identity and is not yielded at all. */
  globalId: string;
  /** The registry's PascalCase spelling where the `EntityTable` has no row (and
   *  so answers `'Unknown'`), the table's own type name otherwise. */
  ifcType: string;
  /** Set only when the entity is absent from the `EntityTable`, whose display
   *  accessors then answer '' for every attribute. */
  source: RootAttributes | undefined;
  /** True for an `IfcTypeObject` subtype (issue #2021). Decided from the same
   *  cross-schema inheritance chain as {@link ComparableEntity.ifcType}, so a
   *  type class no bundled schema declares is `false` rather than guessed —
   *  the fingerprint then simply carries no `Tag`, which is the same answer as
   *  a type object that has none. */
  isTypeObject: boolean;
}

/** How an uppercase STEP type participates in the comparison. `name` is the
 *  registry's PascalCase spelling. */
interface TypeRole {
  role: 'independent' | 'dependent' | 'unknown';
  name: string;
  /** Whether the class is an `IfcTypeObject`; see
   *  {@link ComparableEntity.isTypeObject}. */
  typeObject: boolean;
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
 * does not hold — real objects with real GlobalIds, which the walk this
 * replaced did compare — and let through the IFC2X3-only *resource* classes it
 * does hold under a `…STYLE` name, keyed on the Name in slot 0. Both are wrong
 * answers about an IFC2X3 file, which is still most of what is in the wild.
 *
 * `unknown` is still not `dependent`: a vendor extension no schema declares has
 * no chain to judge, so it keeps exactly the reach the `EntityTable` gives it —
 * which for a `…TYPE` class is a genuine GlobalId, since the parser's
 * type-object branch is name-based and takes those in. Guessing that an
 * unrecognised class is an `IfcObject` and reading its source record instead
 * would cost one STEP extraction per row of every unrecognised bucket in the
 * file, on every file, to reach entities almost no file has. The price of that
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
    return {
      role: upper.startsWith('IFCREL') ? 'dependent' : 'unknown',
      name: typeKey,
      typeObject: false,
    };
  }
  // The chain holds the class itself plus its supertypes; which end the leaf
  // sits at is the schema source's business, so find it by name.
  const name = chain.find((ancestor) => ancestor.toUpperCase() === upper) ?? typeKey;
  const typeObject = chain.includes('IfcTypeObject');
  if (!chain.includes('IfcRoot')) return { role: 'dependent', name, typeObject };
  return {
    role: chain.includes('IfcObjectDefinition') ? 'independent' : 'dependent',
    name,
    typeObject,
  };
}

/**
 * Walk a store's entity index and yield every entity the comparison covers.
 *
 * Lazy on purpose: `--by-entity` only needs the keys, and a generator lets it
 * collect them without materialising a second array per file.
 */
export function* comparableEntities(store: IfcDataStore): Generator<ComparableEntity> {
  const seen = new Set<number>();
  // One extractor for the whole file: it holds a buffer reference, and the
  // source read below only fires for the (small) set of object types the
  // EntityTable declines to hold.
  const extractor = new EntityExtractor(store.source);

  for (const [typeKey, ids] of store.entityIndex.byType) {
    const type = classifyType(typeKey);
    if (type.role === 'dependent') continue;

    for (const expressId of ids) {
      if (seen.has(expressId)) continue;
      seen.add(expressId);

      let globalId = store.entities.getGlobalId(expressId);
      let source: RootAttributes | undefined;
      if (!globalId && type.role === 'independent') {
        // In the file but not in the table: a schedule task, an actor, a work
        // plan. Its GlobalId is in the STEP record, so read it there.
        source = readRootAttributes(extractor, store, expressId);
        globalId = source?.globalId ?? '';
      }
      // Still nothing: the entity is not an IfcRoot at all (a placement, a
      // profile, a representation item), so it has no cross-file identity.
      if (!globalId) continue;

      const tableType = store.entities.getTypeName(expressId);
      // `getTypeName` answers 'Unknown' for a row the table never took in. The
      // registry's own spelling is the honest answer, and on the content path
      // it has to be a real type name: `ifcType` is hashed into the fingerprint
      // and cross-checked on every match, so 'Unknown' would pair a task with
      // an actor.
      const ifcType = source && (!tableType || tableType === 'Unknown') ? type.name : tableType;
      yield { expressId, globalId, ifcType, source, isTypeObject: type.typeObject };
    }
  }
}

/** The comparison's key set for one file: every covered entity's GlobalId. */
export function comparableGlobalIds(store: IfcDataStore): Set<string> {
  const keys = new Set<string>();
  for (const entity of comparableEntities(store)) keys.add(entity.globalId);
  return keys;
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
