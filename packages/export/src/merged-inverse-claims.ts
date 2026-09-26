/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One-relationship-per-inverse bookkeeping for a merge (#5471, #5726, #5774).
 *
 * A merge unifies entities (by GlobalId, and spatially), but never
 * relationships: every model's rels are written, re-stamped. So an entity
 * unified across two models is named by both models' rels, and where IFC
 * bounds the inverse those rels fill to one (`SET [0:1]`), the output breaks
 * it. {@link inverseRules} lists those inverses per output schema, and
 * {@link claimInverses} is the one pass that keeps each of them to one.
 *
 * Split out of {@link ../merged-exporter.ts} (kept under its module-size
 * budget) rather than duplicated: `findEntitiesByType`/`extractStepAttribute`
 * stay the single source of truth in `MergedExporter` and are passed in here,
 * so this file has no data-model logic of its own to drift from it.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { filterHiddenRefsFromRelationshipLine } from './reference-collector.js';
import { readStepSlots, replaceStepArgument } from './step-argument-parser.js';
import type { IfcSchemaVersion } from './schema-converter.js';

/**
 * One relationship attribute whose entities carry a single-valued inverse:
 * the entity named at `claimed` may be named there by at most one written rel
 * (of any type sharing `inverse`).
 */
export interface InverseRule {
  /** The EXPRESS inverse on the claimed entity. Rels that share an inverse share its claims. */
  inverse: string;
  /** Attribute index of the side that carries the inverse. */
  claimed: number;
  /** Attribute index of the other side: what the claimed entity is related to. */
  partner: number;
  /** A WHERE rule bounds the partner list to one, so nothing can be folded into it. */
  onePartner?: true;
  /** The bound is this WHERE rule, not the inverse's cardinality (IFC2X3 `IfcObject.WR1`). */
  where?: string;
}

/** Shorthand for a row: `inverse` on attribute `claimed`, related to attribute `partner`. */
const rule = (inverse: string, claimed: number, partner: number, extra: Partial<InverseRule> = {}): InverseRule => ({ inverse, claimed, partner, ...extra });
type RuleTable = ReadonlyMap<string, readonly InverseRule[]>;

/**
 * Rows every schema shares (#5923): containment, voids and fills, coverings,
 * flow control, ports, services and structural activity. Each is `SET [0:1]`
 * (or exactly one) on the claimed side in IFC2X3, IFC4 and IFC4X3.
 */
const SHARED_ROWS: Array<[string, InverseRule[]]> = [
  ['IFCRELCONTAINEDINSPATIALSTRUCTURE', [rule('ContainedInStructure', 4, 5)]],
  ['IFCRELVOIDSELEMENT', [rule('VoidsElements', 5, 4)]],
  ['IFCRELFILLSELEMENT', [rule('FillsVoids', 5, 4)]],
  ['IFCRELPROJECTSELEMENT', [rule('ProjectsElements', 5, 4)]],
  ['IFCRELCOVERSSPACES', [rule('CoversSpaces', 5, 4)]],
  ['IFCRELFLOWCONTROLELEMENTS', [rule('AssignedToFlowElement', 4, 5), rule('HasControlElements', 5, 4)]],
  ['IFCRELCONNECTSPORTS', [rule('ConnectedTo', 4, 5), rule('ConnectedFrom', 5, 4)]],
  ['IFCRELSERVICESBUILDINGS', [rule('ServicesBuildings', 4, 5)]],
];

/**
 * Relationship type (uppercase) → its single-valued inverses, per OUTPUT
 * schema, list-side rules first. Every row is checked against the EXPRESS
 * schemas in `merged-inverse-claims.test.ts`, which also lists the one
 * single-valued relationship inverse left out and why.
 *
 * IFC2X3: `IfcObjectDefinition.Decomposes : SET [0:1] OF IfcRelDecomposes`,
 * and IfcRelAggregates and IfcRelNests are both IfcRelDecomposes, so one
 * nesting and one aggregation parent together are already two (#5726).
 * `IfcPropertySetDefinition.PropertyDefinitionOf : SET [0:1] OF
 * IfcRelDefinesByProperties` (#5774). A type has one IfcRelDefinesByType
 * (`ObjectTypeOf`), and `IfcObject.WR1` (a WHERE rule, not an inverse bound)
 * allows an object one. IFC4 and later split `Nests : SET [0:1] OF IfcRelNests`
 * off `Decomposes : SET [0:1] OF IfcRelAggregates`, name the typing inverses
 * `IsTypedBy`/`Types`, and relax the property-set side to
 * `DefinesOccurrence : SET [0:?]`, so a property set may be shared by several
 * IfcRelDefinesByProperties there.
 */
const PROPERTY_DEFINITION_OF = rule('PropertyDefinitionOf', 5, 4);
const IFC2X3_RULES: RuleTable = new Map([
  ...SHARED_ROWS,
  ['IFCRELAGGREGATES', [rule('Decomposes', 5, 4)]],
  ['IFCRELNESTS', [rule('Decomposes', 5, 4)]],
  ['IFCRELDEFINESBYPROPERTIES', [PROPERTY_DEFINITION_OF]],
  // `IfcRelOverridesProperties.WR1`: `SIZEOF(RelatedObjects) = 1`.
  ['IFCRELOVERRIDESPROPERTIES', [{ ...PROPERTY_DEFINITION_OF, onePartner: true }]],
  ['IFCRELDEFINESBYTYPE', [rule('IsDefinedBy', 4, 5, { where: 'IfcObject.WR1' }), rule('ObjectTypeOf', 5, 4)]],
  ['IFCRELCOVERSBLDGELEMENTS', [rule('Covers', 5, 4)]],
  ['IFCRELCONNECTSPORTTOELEMENT', [rule('ContainedIn', 4, 5)]],
  ['IFCRELCONNECTSSTRUCTURALACTIVITY', [rule('AssignedToStructuralItem', 5, 4)]],
  ['IFCRELASSIGNSTOGROUP', [rule('IsGroupedBy', 6, 4)]],
  ['IFCRELASSIGNSTASKS', [rule('ScheduleTimeControlAssigned', 7, 6)]],
]);
const IFC4_ROWS: Array<[string, InverseRule[]]> = [
  ...SHARED_ROWS,
  ['IFCRELAGGREGATES', [rule('Decomposes', 5, 4)]],
  ['IFCRELNESTS', [rule('Nests', 5, 4)]],
  ['IFCRELDEFINESBYTYPE', [rule('IsTypedBy', 4, 5), rule('Types', 5, 4)]],
  ['IFCRELDEFINESBYOBJECT', [rule('IsDeclaredBy', 4, 5)]],
  ['IFCRELDECLARES', [rule('HasContext', 5, 4)]],
  ['IFCRELCOVERSBLDGELEMENTS', [rule('CoversElements', 5, 4)]],
  ['IFCRELCONNECTSPORTTOELEMENT', [rule('ContainedIn', 4, 5)]],
  ['IFCRELCONNECTSSTRUCTURALACTIVITY', [rule('AssignedToStructuralItem', 5, 4)]],
];
const IFC4_RULES: RuleTable = new Map(IFC4_ROWS);
const IFC4X3_RULES: RuleTable = new Map([...IFC4_ROWS, ['IFCRELADHERESTOELEMENT', [rule('AdheresToElement', 5, 4)]]]);

/** The rule table of an output schema (IFC5 falls back to IFC4X3's). */
export function inverseRules(outputSchema: IfcSchemaVersion): RuleTable {
  return outputSchema === 'IFC2X3' ? IFC2X3_RULES : outputSchema === 'IFC4' ? IFC4_RULES : IFC4X3_RULES;
}

/** The written rel a single-valued claimed entity already belongs to. */
interface Owner {
  /** Final express id of the rel. */
  rel: number;
  /** Its type: a rel folds only into an owner of its own type (an override is not a plain definition). */
  relType: string;
  /** Attribute index of its partner side. */
  partnerIndex: number;
  /** Final ids already on its partner side. */
  partners: Set<number>;
}

/**
 * Which final ids already fill each single-valued inverse in the merge output.
 * One instance per merge, grown model by model in merge order.
 */
export class InverseClaims {
  /** Relationship type (uppercase) → the rules it is claimed under. */
  readonly rules: ReadonlyMap<string, readonly InverseRule[]>;
  /** Claimed through a list side (RelatedObjects, RelatedElements): the ids alone. */
  private readonly members = new Map<string, Set<number>>();
  /** Claimed through a single side (RelatingPropertyDefinition): the rel that owns each. */
  private readonly owners = new Map<string, Map<number, Owner>>();
  /** Final rel id → partner ids a later, folded rel adds to its partner list. */
  readonly folds = new Map<number, { partnerIndex: number; ids: number[] }>();
  /** Later rels withheld with partners no owner could take: final rel id → how many. */
  readonly unfolded = new Map<number, number>();

  /** `only` narrows the claimed relationship types (the #5725 drop planner's view). */
  constructor(outputSchema: IfcSchemaVersion, only: (relType: string) => boolean = () => true) {
    this.rules = new Map([...inverseRules(outputSchema)].filter(([relType]) => only(relType)));
  }

  membersOf(inverse: string): Set<number> {
    let ids = this.members.get(inverse);
    if (ids === undefined) this.members.set(inverse, (ids = new Set()));
    return ids;
  }

  ownersOf(inverse: string): Map<number, Owner> {
    let owners = this.owners.get(inverse);
    if (owners === undefined) this.owners.set(inverse, (owners = new Map()));
    return owners;
  }

  /** Move `ids` onto `owner`'s partner list, in place of a rel that would have been a second one. */
  fold(owner: Owner, ids: number[]): void {
    for (const id of ids) owner.partners.add(id);
    const fold = this.folds.get(owner.rel);
    if (fold === undefined) this.folds.set(owner.rel, { partnerIndex: owner.partnerIndex, ids: [...ids] });
    else fold.ids.push(...ids);
  }
}

/** What {@link claimInverses} needs to know about one model's plan. */
export interface InverseClaimInput {
  dataStore: IfcDataStore;
  /** Local id → final id for every unified entity (spatial, infrastructure, GlobalId). */
  sharedRemap: ReadonlyMap<number, number>;
  /** This model's id offset: an unremapped local id's final id is `id + idOffset`. */
  idOffset: number;
  /** Local ids not written; a skipped rel claims nothing, and a rel skipped here is added. */
  skipEntityIds: Set<number>;
  /** Local rel id → member ids to drop from its written claimed list. */
  relMemberStrip: Map<number, Set<number>>;
  /**
   * Whether a local id survives into the output as a reference: false for a
   * hidden product under `visibleOnly` or a dropped empty container, which
   * `renderEntity` narrows out of (or, as a single-valued ref, withholds) the rel.
   */
  isEmitted: (localId: number) => boolean;
  /** Whether the rel line itself is in the written set at all (visibility closure). */
  isIncluded: (localId: number) => boolean;
  /** Strip already-claimed members (a later, unified model); false just records claims. */
  dedupe: boolean;
}

/** One side of a rel line, as written: its emitted refs, and whether it is a list. */
interface Side {
  list: boolean;
  refs: number[];
}

/**
 * Keep one written rel per entity and single-valued inverse across a merge
 * (#5471, #5726, #5774).
 *
 * Called once per model in merge order, after all of that model's unification
 * and container drops. `claims` holds what the output already says: every rel
 * the model will write records its claims. A rel that will not be written
 * (skipped, outside the visibility closure, or with a hidden or dropped
 * single-valued side) claims nothing, and neither does a member narrowed out
 * of it, so a later model's rel stays in place for an entity whose primary rel
 * is not in the output.
 *
 * With `dedupe`, a later rel naming an already-claimed entity is resolved by
 * the claimed side's shape:
 * - a LIST side (an object's parent, #5471): the claimed members are stripped
 *   into `relMemberStrip` for {@link applyRelMemberStrip}, and a rel left with
 *   none is skipped. The first parent wins. A unified member with no parent yet
 *   is kept, since that rel is then its only parentage statement (#3550).
 * - a SINGLE side (a property set's one definer, #5774): the rel is skipped.
 *   If its partner side is a list naming objects the owning rel does not, those
 *   are folded into the owning rel ({@link InverseClaims.fold}, written by
 *   {@link applyInverseFolds}), so the entity keeps one rel and loses no member.
 *   Where no fold is possible (a single partner, an owner of another rel type,
 *   or a partner list a WHERE rule bounds to one) the first rel wins, and
 *   {@link applyInverseFolds} reports the objects that lost the relationship.
 */
export function claimInverses(
  input: InverseClaimInput,
  claims: InverseClaims,
  findEntitiesByType: (dataStore: IfcDataStore, typeUpper: string) => number[],
  extractStepAttribute: (expressId: number, dataStore: IfcDataStore, attrIndex: number) => string | null,
): void {
  const { dataStore, sharedRemap, idOffset, skipEntityIds, relMemberStrip, isEmitted, isIncluded, dedupe } = input;
  const finalId = (ref: number) => sharedRemap.get(ref) ?? ref + idOffset;
  for (const [relType, rules] of claims.rules) {
    const indices = [...new Set(rules.flatMap(rule => [rule.claimed, rule.partner]))];
    for (const relId of findEntitiesByType(dataStore, relType)) {
      if (skipEntityIds.has(relId) || !isIncluded(relId)) continue;
      const sides = new Map<number, Side>();
      let written = true;
      for (const index of indices) {
        const side = readSide(extractStepAttribute(relId, dataStore, index), isEmitted);
        if (side === 'withheld') written = false;
        else if (side !== null) sides.set(index, side);
      }
      if (!written) continue;
      const strip = new Set<number>();
      const live = (index: number) => (sides.get(index)?.refs ?? []).filter(ref => !strip.has(ref));
      let skip = false;
      let fold: { owner: Owner; ids: number[] } | undefined;
      const newOwners: Array<[Map<number, Owner>, number, InverseRule]> = [];
      // List sides first: what they strip is no longer a partner a single side can fold.
      for (const rule of [...rules].sort((a, b) => Number(!sides.get(a.claimed)?.list) - Number(!sides.get(b.claimed)?.list))) {
        const claimed = sides.get(rule.claimed);
        if (claimed === undefined) continue;
        if (claimed.list) {
          const members = live(rule.claimed);
          const claimedIds = claims.membersOf(rule.inverse);
          const redundant = dedupe ? members.filter(ref => claimedIds.has(finalId(ref))) : [];
          for (const ref of redundant) strip.add(ref);
          if (redundant.length > 0 && redundant.length === members.length) skip = true;
        } else {
          const owners = claims.ownersOf(rule.inverse);
          const owner = owners.get(finalId(claimed.refs[0]));
          if (owner === undefined) newOwners.push([owners, claimed.refs[0], rule]);
          else if (dedupe) {
            skip = true;
            const fresh = [...new Set(live(rule.partner).map(finalId))].filter(id => !owner.partners.has(id));
            const foldable = sides.get(rule.partner)?.list && owner.relType === relType && !rule.onePartner;
            if (fresh.length > 0 && foldable) fold = { owner, ids: fresh };
            else if (fresh.length > 0) claims.unfolded.set(finalId(relId), fresh.length);
          }
        }
        if (skip) break;
      }
      if (fold !== undefined) claims.fold(fold.owner, fold.ids);
      if (skip && fold === undefined) {
        skipEntityIds.add(relId);
        continue;
      }
      // Kept, or folded into its owner: either way its surviving members are now written.
      for (const rule of rules) {
        if (sides.get(rule.claimed)?.list) for (const ref of live(rule.claimed)) claims.membersOf(rule.inverse).add(finalId(ref));
      }
      if (skip) {
        skipEntityIds.add(relId);
        continue;
      }
      if (strip.size > 0) relMemberStrip.set(relId, strip);
      for (const [owners, ref, rule] of newOwners) {
        owners.set(finalId(ref), { rel: finalId(relId), relType, partnerIndex: rule.partner, partners: new Set(live(rule.partner).map(finalId)) });
      }
    }
  }
}

/**
 * One rel attribute as the output will carry it: `null` when it names nothing
 * (`$`, a value), `'withheld'` when the line is not written because of it (a
 * single ref, or every member of a list, that is not emitted).
 */
function readSide(attr: string | null, isEmitted: (id: number) => boolean): Side | 'withheld' | null {
  if (!attr) return null;
  const trimmed = attr.trim();
  const list = trimmed.startsWith('(');
  // A single side is claimable only as a bare ref: an IFC4 IfcPropertySetDefinitionSet(...) is not one entity.
  if (!list && !/^#\d+$/.test(trimmed)) return null;
  const all = listRefs(trimmed);
  if (all.length === 0) return null;
  const refs = all.filter(isEmitted);
  return refs.length === 0 ? 'withheld' : { list, refs };
}

/** The `#id`s in one STEP attribute, in order; `[]` for a missing one. */
function listRefs(attr: string): number[] {
  const refs: number[] = [];
  const refRegex = /#(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(attr)) !== null) refs.push(parseInt(match[1], 10));
  return refs;
}

/**
 * Render-time counterpart of {@link claimInverses}: drop the claimed members
 * of a partially redundant rel that already fill that inverse in the output.
 * Reuses the same list/scalar-aware ref filter the `visibleOnly`/deletion
 * dangling-ref path uses. Must run in LOCAL id space, before any id
 * offset/remap — `localId` and the ids inside `relMemberStrip` are both local
 * to the model being rendered.
 *
 * Returns `entityText` unchanged when `localId` has no strip entry, and
 * `null` when the filter would withhold the whole line — a strip set built
 * by {@link claimInverses} is a strict subset of the claimed list, so for
 * well-formed input the filter only narrows, but a degenerate file (a
 * stripped member id that also appears as a single-valued ref, e.g.
 * self-aggregation) can null the line. The caller must withhold it, like
 * every other user of the filter: every edge the line declared is already
 * declared by the primary model, and emitting the unfiltered bytes instead
 * would reintroduce the duplicate membership this module exists to remove.
 */
export function applyRelMemberStrip(
  entityText: string,
  localId: number,
  relMemberStrip: ReadonlyMap<number, ReadonlySet<number>>,
): string | null {
  const toStrip = relMemberStrip.get(localId);
  if (toStrip === undefined) return entityText;
  return filterHiddenRefsFromRelationshipLine(entityText, id => toStrip.has(id));
}

/**
 * Write the folds of {@link claimInverses} into the rendered output: each
 * owning rel's partner list gains the members of the later rels folded into
 * it. Runs once, on the final lines (final id space), after every model is
 * rendered, since an owner may be written before the rel that folds into it.
 * Returns a warning per later rel whose objects lost the relationship: one
 * no owner could take (a different rel type, or a partner list bounded to
 * one), and one folded into an owner that did not reach the output as a line
 * with a partner list.
 */
export function applyInverseFolds(lines: string[], claims: InverseClaims): string[] {
  const lost = [...claims.unfolded].map(([rel, count]) =>
    `A later model's relationship (merged id #${rel}) was not written: an earlier model already wrote one for the same merged entity, and it could not take the ${count} other object(s) the later one named, so those objects lost that relationship.`);
  if (claims.folds.size === 0) return lost;
  const pending = new Map(claims.folds);
  for (let i = 0; i < lines.length && pending.size > 0; i++) {
    const rel = Number(/^#(\d+)=/.exec(lines[i])?.[1]);
    const fold = pending.get(rel);
    if (fold === undefined) continue;
    const list = readStepSlots(lines[i])?.slots[fold.partnerIndex]?.trim();
    if (list === undefined || !list.startsWith('(') || !list.endsWith(')')) continue;
    const inner = list.slice(1, -1).trim();
    const added = fold.ids.map(ref => `#${ref}`).join(',');
    const next = replaceStepArgument(lines[i], fold.partnerIndex, `(${inner === '' ? added : `${inner},${added}`})`);
    if (next === null) continue;
    lines[i] = next;
    pending.delete(rel);
  }
  return [...lost, ...[...pending].map(([rel, { ids }]) =>
    `Could not add ${ids.length} object(s) to relationship #${rel}, which a later model's duplicate relationship was merged into; those objects lost that relationship.`)];
}
