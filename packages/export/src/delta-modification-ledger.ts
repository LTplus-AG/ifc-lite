/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bookkeeping behind the STEP header's `"Re-exported by ifc-lite, N
 * modification(s)"` claim, behind `stats.modifiedEntityCount`, and behind the
 * warning that says what a delta could not carry.
 *
 * A full export counts at the INTENT sites for the kinds an entity's own line
 * carries, and that is sound there: the source-iteration pass writes every
 * modified host's own (rewritten) line, so intending to modify an emittable host
 * and emitting the modification are the same event. Property and quantity sets
 * are the exception — see {@link EFFECT_SETTLED_KINDS}.
 *
 * `deltaOnly` breaks that identity. It skips the source-iteration pass
 * wholesale, so the only lines a source-backed host can contribute to a delta
 * are the ones the property-set generator, the quantity-set generator and the
 * type-object `HasPropertySets` rewrite produce for it. A modification with no
 * such line is simply not in the file:
 *
 *   - an in-place attribute edit (`setAttribute`) is applied by rewriting the
 *     entity's own line inside the skipped pass — the report in #2462;
 *   - a georeferencing edit to an EXISTING `IfcProjectedCRS` /
 *     `IfcMapConversion` is queued as exactly such attribute edits;
 *   - a property/quantity-set DELETION produces no replacement content, so
 *     there is nothing for the delta to carry either. (A full export applies a
 *     rel-defined removal by OMITTING the pset and its relationship, not by
 *     rewriting the host's line; either way a delta has no line to carry.)
 *
 * All three used to count. The header then claimed a modification the DATA
 * section did not contain — for an attribute-only session, `"1 modification"`
 * over zero entity lines. So a delta's count is settled at the end, from what
 * was actually emitted.
 *
 * ## Why the ledger is keyed on (entity, kind) and not on the entity
 *
 * One host can carry edits of several kinds, and the passes that survive
 * `deltaOnly` deliver some kinds and not others. Rename a wall AND add a
 * property set to it: the pset generator writes replacement lines, the rename
 * has nowhere to go. Keyed per ENTITY, that pset emission marked the whole host
 * delivered, so the ledger reported one delivered modification and said nothing
 * about the rename — a caller could apply the delta believing the rename was in
 * it. That is the same silent misreport this module exists to remove, one level
 * down, so delivery is tracked per EDIT KIND:
 *
 *   - {@link ModificationLedger.nominate} takes the kind that was edited;
 *   - {@link ModificationLedger.recordEmitted} takes the kind the emitted
 *     content genuinely delivers — generated pset lines deliver `property-set`
 *     and nothing else; a rewritten source line delivers the in-place kinds
 *     ({@link recordSourceLineDelivery});
 *   - {@link ModificationLedger.settle} counts an ENTITY as modified when ANY
 *     of its kinds was delivered — `modifiedEntityCount` counts entities and
 *     the header claim is unchanged by this keying — but warns for EVERY
 *     nominated-and-undelivered (entity, kind) pair.
 *
 * The warning names the kind, deliberately. "entity #8's edits were not
 * carried" is subtly false when only the rename was dropped and the pset landed,
 * and a warning a reader learns to distrust is worse than no warning. One
 * warning per kind also lets each one say WHY that kind cannot survive a delta,
 * which is the actionable part.
 *
 * ## What is still not covered
 *
 * Retypes and positional edits are nominated only by the source-iteration pass,
 * which `deltaOnly` skips — so a delta still drops them without naming them.
 * They are not lost in every case: the type-object `HasPropertySets` rewrite
 * runs the whole mutation pipeline, so a retype or positional edit to such a
 * host does reach the delta and IS recorded as delivered here. It is the
 * nomination that a delta cannot see, not the delivery.
 *
 * That leaves one narrow spot where the count under-claims rather than
 * over-claims: a type object whose repoint FAILED, whose only other edit is a
 * retype or a positional edit, emits its fallback line while nothing nominated
 * the kind that line carries. Every other delta drops those two kinds without
 * emitting anything at all, where claiming nothing is exactly right.
 *
 * NOTE this is all about what a DELTA contains, not about what may reference a
 * source host. `willBeEmitted` / `hasEmittableHostBytes` deliberately answer
 * "yes" for a source record under `deltaOnly` — a generated
 * `IFCRELDEFINESBYPROPERTIES` may name a host whose line lives in the file
 * being patched. That carve-out is right, and orthogonal to this count.
 */

/**
 * What was edited about a host. Every value here is a distinction the exporter
 * can actually make at its own nomination sites — no finer, because a kind the
 * emit passes cannot tell apart could never be settled.
 */
export type ModificationKind =
  | 'attribute'
  | 'georeferencing'
  | 'property-set'
  | 'quantity-set'
  | 'retype'
  | 'positional';

/**
 * The kinds whose intent site is NOT their emit site, even in a FULL export —
 * so their count is settled from effect in both modes (#2474).
 *
 * A pset/qset edit is nominated when the session's mutation history names the
 * set, long before anything asks whether that name resolves to content. It
 * frequently does not: `deletePropertySet(id, 'AName')` on a host that owns no
 * such set nominates, matches nothing, generates nothing, withholds nothing —
 * and used to put "1 modification" in the header of a byte-identical file. The
 * same shape reaches the quantity side through an UNDONE quantity-set creation,
 * whose `CREATE_QUANTITY` record stays in the append-only history after the
 * overlay has dropped the set.
 *
 * The other four kinds are written by the very pass that nominates them, or by
 * one that reports back: `retype` and `positional` are nominated inside the
 * source-iteration pass and only when the line actually changed, and
 * `attribute` / `georeferencing` are applied to that same line.
 *
 * ## What counts as CHANGED for a set
 *
 * The test is effect on the emitted FILE, not equality of property values: this
 * export either wrote a line for the host's set or left one out. Regenerating a
 * set with identical values still counts, because the replacement carries fresh
 * express ids and genuinely is different bytes — "the same properties" is not
 * the same file, and pretending otherwise would need a comparison this pass
 * cannot make (it never reads the lines it replaced). Deleting a set that
 * exists counts through the WITHHELD side ({@link
 * ModificationLedger.recordWithheld}); deleting one that does not exist touches
 * neither side and is what stopped counting.
 */
const EFFECT_SETTLED_KINDS: ReadonlySet<ModificationKind> = new Set([
  'property-set',
  'quantity-set',
]);

/** Fixed order, so `stats.warnings` is deterministic across runs. */
const KIND_ORDER: readonly ModificationKind[] = [
  'attribute',
  'georeferencing',
  'retype',
  'positional',
  'property-set',
  'quantity-set',
];

/**
 * How many expressIds the "deltaOnly dropped these edits" warning names before
 * it summarises the rest. A session can edit thousands of entities and this
 * string is read by a human, not parsed.
 */
const UNDELIVERED_IDS_IN_WARNING = 5;

/** Plural noun and the reason a delta cannot carry that kind, per kind. */
const KIND_REPORT: Record<ModificationKind, { nouns: string; why: string }> = {
  attribute: {
    nouns: 'attribute edits',
    why: 'a full export applies one by rewriting the entity\'s own line, and a delta contains no source lines',
  },
  georeferencing: {
    nouns: 'georeferencing edits',
    why: 'they are queued as attribute edits on the existing IfcProjectedCRS / IfcMapConversion, '
      + 'which a full export applies by rewriting that entity\'s own line',
  },
  retype: {
    nouns: 'retypes',
    why: 'a full export applies one by rewriting the entity\'s own line, and a delta contains no source lines',
  },
  positional: {
    nouns: 'positional edits',
    why: 'a full export applies one by rewriting the entity\'s own line, and a delta contains no source lines',
  },
  'property-set': {
    nouns: 'property-set changes',
    why: 'a removal produces no replacement content for a delta to carry (a full export applies it by '
      + 'omitting the removed lines)',
  },
  'quantity-set': {
    nouns: 'quantity-set changes',
    why: 'a removal produces no replacement content for a delta to carry (a full export applies it by '
      + 'omitting the removed lines)',
  },
};

export interface ModificationLedger {
  /** This host has an edit of `kind` that would make it count as modified. */
  nominate(entityId: number, kind: ModificationKind): void;
  /** A pass wrote content that genuinely delivers this host's `kind` edit. */
  recordEmitted(entityId: number, kind: ModificationKind): void;
  /**
   * A pass left content OUT of the file because of this host's `kind` edit —
   * the way a full export applies a set deletion, and the other half of "did
   * this edit change the file".
   *
   * Deliberately not `recordEmitted`: under `deltaOnly` there is no source
   * content to leave out, so withholding delivers nothing there and the
   * existing "a removal produces no replacement content for a delta to carry"
   * warning stays exactly right.
   */
  recordWithheld(entityId: number, kind: ModificationKind): void;
  /**
   * This host's `kind` edit did NOT land, and a more specific warning has
   * already said so. Keeps the pair out of the count (it really is undelivered)
   * and out of the generic warning, which would otherwise blame the delta
   * format for a drop that has nothing to do with it.
   */
  acknowledgeUndelivered(entityId: number, kind: ModificationKind): void;
  /** Final count, plus a warning per kind the file left undelivered. */
  settle(): { modifiedEntityCount: number; warnings: string[] };
}

export function createModificationLedger(deltaOnly: boolean): ModificationLedger {
  // Per kind, in nomination order - the warning lists ids in the order the
  // session produced them. Both modes keep the same books; what differs is
  // which kinds a nomination delivers on its own, and whether an undelivered
  // pair is worth a warning (a full export has no delta format to blame).
  //
  // `modifiedEntityCount` counts ENTITIES, and the exporter nominates from
  // seven sites (property sets, quantity sets, named attributes, the two
  // georeferencing branches, and retype + positional inside the
  // source-iteration pass). Several of those legitimately fire for the same
  // host in one session; counting entities is what keeps that one modification.
  const nominated = new Map<ModificationKind, Set<number>>();
  const delivered = new Map<ModificationKind, Set<number>>();
  const acknowledged = new Map<ModificationKind, Set<number>>();
  const mark = (
    index: Map<ModificationKind, Set<number>>,
    entityId: number,
    kind: ModificationKind,
  ): void => {
    let ids = index.get(kind);
    if (!ids) {
      ids = new Set<number>();
      index.set(kind, ids);
    }
    ids.add(entityId);
  };
  const has = (
    index: Map<ModificationKind, Set<number>>,
    entityId: number,
    kind: ModificationKind,
  ): boolean => index.get(kind)?.has(entityId) === true;

  return {
    nominate: (entityId, kind) => {
      mark(nominated, entityId, kind);
      // In a FULL export the kinds an entity's own line carries are written by
      // the pass that nominates them, so there is no emission to wait for and
      // the nomination settles itself. The set kinds are the exception - see
      // `EFFECT_SETTLED_KINDS`.
      if (!deltaOnly && !EFFECT_SETTLED_KINDS.has(kind)) mark(delivered, entityId, kind);
    },
    recordEmitted: (entityId, kind) => { mark(delivered, entityId, kind); },
    recordWithheld: (entityId, kind) => {
      if (!deltaOnly) mark(delivered, entityId, kind);
    },
    acknowledgeUndelivered: (entityId, kind) => { mark(acknowledged, entityId, kind); },
    settle: () => {
      // An entity counts once, however many of its kinds landed - the header
      // claim is per entity and this keying must not inflate it. Only a
      // NOMINATED pair can count: a pass records what it wrote without asking
      // whether the host was countable, and an overlay-created host's generated
      // psets are already counted in `newEntityCount`.
      const deliveredEntities = new Set<number>();
      const warnings: string[] = [];
      for (const kind of KIND_ORDER) {
        const ids = nominated.get(kind);
        if (!ids) continue;
        const undelivered: number[] = [];
        for (const entityId of ids) {
          // Delivery wins over an acknowledgement: a pass that reported a
          // partial failure may still have delivered this kind by another route.
          if (has(delivered, entityId, kind)) deliveredEntities.add(entityId);
          else if (!has(acknowledged, entityId, kind)) undelivered.push(entityId);
        }
        // A full export's undelivered pair is not a limitation of the output
        // format - it is an edit that resolved to nothing, such as deleting a
        // set the host never had. There is no other flag to re-export with and
        // nothing for the caller to do, so it is reported by the count alone:
        // zero modifications over a file this export did not change.
        if (deltaOnly && undelivered.length > 0) warnings.push(undeliveredWarning(kind, undelivered));
      }
      return { modifiedEntityCount: deliveredEntities.size, warnings };
    },
  };
}

/**
 * Which kinds a rewritten source line actually DELIVERED.
 *
 * Every flag is an effect, measured by comparing the line across the operation
 * that claims it — never "an edit of this kind was requested". A retype to the
 * class the entity already is, a positional write of the token already in the
 * slot, and a named attribute the class has no slot for all leave the text
 * exactly as it was, and a line that did not change delivered nothing.
 */
export interface SourceLineDelivery {
  attributed: boolean;
  retyped: boolean;
  positional: boolean;
}

/**
 * Record what a rewritten SOURCE LINE delivered for `entityId`.
 *
 * A source line carries every IN-PLACE edit and nothing else: property and
 * quantity sets live in separate records, and a type object's type-owned pset
 * edit is delivered by the `HasPropertySets` REPOINT, not by the line rewrite
 * that carries it — which is why the repoint site records `property-set`
 * itself and the fallback site (where the repoint failed) does not.
 *
 * Only the kinds the mutation pipeline REPORTS having applied. A named
 * attribute whose name resolves to no slot in the record's class is discarded
 * by `applyAttributeMutations`, and calling that delivered would re-create the
 * exact misreport this ledger exists to remove. `attributed` covers BOTH kinds
 * a named-attribute rewrite can deliver: georeferencing edits to an existing
 * `IfcProjectedCRS` / `IfcMapConversion` are queued into the very same
 * `modifiedAttributes` map and applied by the very same call.
 */
export function recordSourceLineDelivery(
  ledger: ModificationLedger,
  entityId: number,
  mutated: SourceLineDelivery,
): void {
  if (mutated.attributed) {
    ledger.recordEmitted(entityId, 'attribute');
    ledger.recordEmitted(entityId, 'georeferencing');
  }
  if (mutated.retyped) ledger.recordEmitted(entityId, 'retype');
  if (mutated.positional) ledger.recordEmitted(entityId, 'positional');
}

function undeliveredWarning(kind: ModificationKind, undelivered: number[]): string {
  const shown = undelivered
    .slice(0, UNDELIVERED_IDS_IN_WARNING)
    .map((id) => `#${id}`)
    .join(', ');
  const rest = undelivered.length - UNDELIVERED_IDS_IN_WARNING;
  const subject = undelivered.length === 1 ? 'entity' : 'entities';
  const { nouns, why } = KIND_REPORT[kind];
  return (
    `deltaOnly export carried no ${nouns} for ${undelivered.length} existing ${subject} `
    + `(${shown}${rest > 0 ? `, +${rest} more` : ''}): ${why}. `
    + `Export with deltaOnly disabled to apply ${undelivered.length === 1 ? 'it' : 'them'}.`
  );
}
